import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { createGmailClient, listGmailMessageIds } from "@/lib/google-gmail";
import {
  acquireRunWorker,
  createRunDb,
  createWorkerId,
  markRunIngestionComplete,
  releaseRunWorker,
} from "@/lib/run-worker";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const MAX_BATCH = 1000;

export async function POST(req: Request) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "AUTH_REQUIRED" }, { status: 401 });

  const body = await req.json().catch(() => ({}));
  const runId = typeof body?.runId === "string" ? body.runId : "";
  if (!runId) return NextResponse.json({ error: "runId is required." }, { status: 400 });

  const supabase = createRunDb();
  const workerId = createWorkerId("gmail-ingest");
  let leaseAcquired = false;

  try {
    const { data: run, error: runError } = await supabase
      .from("tool_runs")
      .select(
        "id, connection_id, status, gmail_query, gmail_page_token, target_email_count, queued_message_count, ingestion_complete"
      )
      .eq("id", runId)
      .eq("user_id", user.id)
      .maybeSingle();

    if (runError) throw new Error("Could not load run: " + runError.message);
    if (!run) return NextResponse.json({ error: "Run not found." }, { status: 404 });
    if (run.status !== "running") {
      return NextResponse.json({ error: "Run is not active." }, { status: 409 });
    }
    if (run.ingestion_complete) {
      return NextResponse.json({
        ok: true,
        runId: run.id,
        queuedMessageCount: Number(run.queued_message_count || 0),
        addedThisCall: 0,
        nextPageToken: null,
        ingestionComplete: true,
      });
    }

    await acquireRunWorker(supabase, run.id, workerId);
    leaseAcquired = true;

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
    let queuedCount = Number(run.queued_message_count || 0);
    let addedTotal = 0;
    let pages = 0;
    let reachedEnd = false;

    while (queuedCount < target && pages < 3) {
      const page = await listGmailMessageIds(gmail, query, token);
      pages += 1;

      if (!page.messageIds.length) {
        token = undefined;
        reachedEnd = true;
        break;
      }

      const remaining = target - queuedCount;
      const ids = page.messageIds.slice(0, remaining);

      const { data: added, error } = await supabase.rpc("enqueue_run_email_jobs", {
        p_run_id: run.id,
        p_connection_id: run.connection_id,
        p_message_ids: ids,
      });

      if (error) {
        throw new Error("Could not enqueue Gmail messages: " + error.message);
      }

      addedTotal += Number(added || 0);
      queuedCount += Number(added || 0);
      token = page.nextPageToken || undefined;

      if (!page.nextPageToken || ids.length < remaining) {
        reachedEnd = !page.nextPageToken;
        break;
      }
    }

    const shouldClose = queuedCount >= target || reachedEnd;

    const { error: checkpointError } = await supabase
      .from("tool_runs")
      .update({
        gmail_page_token: token || null,
        gmail_query: query,
        last_heartbeat_at: new Date().toISOString(),
      })
      .eq("id", run.id)
      .eq("user_id", user.id)
      .eq("status", "running");

    if (checkpointError) {
      throw new Error("Could not checkpoint Gmail ingestion: " + checkpointError.message);
    }

    if (shouldClose) {
      await markRunIngestionComplete(supabase, run.id);
    }

    return NextResponse.json({
      ok: true,
      runId: run.id,
      queuedMessageCount: queuedCount,
      addedThisCall: addedTotal,
      nextPageToken: token || null,
      ingestionComplete: shouldClose,
    });
  } catch (error) {
    console.error("Gmail ingestion failed", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Gmail ingestion failed." },
      { status: 500 }
    );
  } finally {
    if (leaseAcquired) {
      await releaseRunWorker(supabase, runId, workerId).catch((error) => {
        console.error("Failed to release Gmail ingestion worker lease", error);
      });
    }
  }
}
