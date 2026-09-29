import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { getCurrentUser } from "@/lib/auth";
import { createGmailClient, listGmailMessageIds } from "@/lib/google-gmail";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const MAX_BATCH = 1000;

function db() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("Supabase environment variables are not configured.");
  return createClient(url, key);
}

export async function POST(req: Request) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "AUTH_REQUIRED" }, { status: 401 });

  const body = await req.json().catch(() => ({}));
  const runId = typeof body?.runId === "string" ? body.runId : "";
  if (!runId) return NextResponse.json({ error: "runId is required." }, { status: 400 });

  const supabase = db();

  try {
    const { data: run, error: runError } = await supabase
      .from("tool_runs")
      .select("id, connection_id, status, gmail_query, gmail_page_token, target_email_count, queued_message_count")
      .eq("id", runId)
      .eq("user_id", user.id)
      .maybeSingle();

    if (runError) throw new Error("Could not load run: " + runError.message);
    if (!run) return NextResponse.json({ error: "Run not found." }, { status: 404 });
    if (run.status !== "running") return NextResponse.json({ error: "Run is not active." }, { status: 409 });

    const { data: connection, error: connectionError } = await supabase
      .from("google_connections")
      .select("id, refresh_token")
      .eq("id", run.connection_id)
      .eq("user_id", user.id)
      .eq("is_active", true)
      .maybeSingle();

    if (connectionError) throw new Error("Could not load Gmail connection: " + connectionError.message);
    if (!connection) return NextResponse.json({ error: "No active Gmail connection found." }, { status: 400 });

    const target = Math.max(1, Math.min(MAX_BATCH, Number(run.target_email_count) || MAX_BATCH));
    const { gmail } = createGmailClient(connection.refresh_token);
    const query = run.gmail_query || "in:inbox";

    let token = run.gmail_page_token || undefined;
    let addedTotal = 0;
    let pages = 0;

    while ((run.queued_message_count || 0) + addedTotal < target && pages < 3) {
      const page = await listGmailMessageIds(gmail, query, token);
      pages += 1;

      if (!page.messageIds.length) {
        token = undefined;
        break;
      }

      const remaining = target - ((run.queued_message_count || 0) + addedTotal);
      const ids = page.messageIds.slice(0, remaining);

      const { data: added, error } = await supabase.rpc("enqueue_run_email_jobs", {
        p_run_id: run.id,
        p_connection_id: run.connection_id,
        p_message_ids: ids,
      });

      if (error) throw new Error("Could not enqueue Gmail messages: " + error.message);

      addedTotal += Number(added || 0);
      token = page.nextPageToken || undefined;

      if (!page.nextPageToken || ids.length < remaining) break;
    }

    const { data: checkpoint, error: checkpointError } = await supabase
      .from("tool_runs")
      .update({
        gmail_page_token: token || null,
        gmail_query: query,
        last_heartbeat_at: new Date().toISOString(),
      })
      .eq("id", run.id)
      .eq("user_id", user.id)
      .eq("status", "running")
      .select("queued_message_count, gmail_page_token")
      .single();

    if (checkpointError) throw new Error("Could not checkpoint Gmail ingestion: " + checkpointError.message);

    return NextResponse.json({
      ok: true,
      runId: run.id,
      queuedMessageCount: checkpoint.queued_message_count,
      addedThisCall: addedTotal,
      nextPageToken: checkpoint.gmail_page_token,
    });
  } catch (error) {
    console.error("Gmail ingestion failed", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Gmail ingestion failed." },
      { status: 500 }
    );
  }
}
