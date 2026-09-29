import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { createRunDb } from "@/lib/run-worker";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const user = await getCurrentUser();

  if (!user) {
    return NextResponse.json({ error: "AUTH_REQUIRED" }, { status: 401 });
  }

  const url = new URL(req.url);
  const runId = url.searchParams.get("runId");

  if (!runId) {
    return NextResponse.json({ error: "runId is required." }, { status: 400 });
  }

  const supabase = createRunDb();

  const { data: run, error } = await supabase
    .from("tool_runs")
    .select(
      "id, status, started_at, completed_at, target_email_count, discovered_message_count, queued_message_count, completed_message_count, failed_message_count, sheet_queued_count, sheet_completed_count, sheet_failed_count, ingestion_complete, last_heartbeat_at, worker_id, worker_lease_expires_at, sheet_worker_id, sheet_worker_lease_expires_at"
    )
    .eq("id", runId)
    .eq("user_id", user.id)
    .maybeSingle();

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  if (!run) {
    return NextResponse.json({ error: "Run not found." }, { status: 404 });
  }

  return NextResponse.json({
    run,
    progress: {
      target: Number(run.target_email_count || 0),
      queued: Number(run.queued_message_count || 0),
      completed: Number(run.completed_message_count || 0),
      failed: Number(run.failed_message_count || 0),
      sheetQueued: Number(run.sheet_queued_count || 0),
      sheetCompleted: Number(run.sheet_completed_count || 0),
      sheetFailed: Number(run.sheet_failed_count || 0),
      remaining: Math.max(
        0,
        Number(run.queued_message_count || 0) -
          Number(run.completed_message_count || 0) -
          Number(run.failed_message_count || 0)
      ),
    },
  });
}
