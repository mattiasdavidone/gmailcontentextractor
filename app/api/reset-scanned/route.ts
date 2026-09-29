import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { createRunDb } from "@/lib/run-worker";

export const dynamic = "force-dynamic";

export async function POST() {
  try {
    const user = await getCurrentUser();

    if (!user) {
      return NextResponse.json({ error: "AUTH_REQUIRED" }, { status: 401 });
    }

    const supabase = createRunDb();

    const { data: connections, error: connectionError } = await supabase
      .from("google_connections")
      .select("id")
      .eq("user_id", user.id)
      .eq("is_active", true);

    if (connectionError) {
      throw new Error(
        "Could not load Gmail connections: " + connectionError.message
      );
    }

    const connectionIds = (connections || [])
      .map((connection) => connection.id)
      .filter(Boolean);

    if (connectionIds.length === 0) {
      return NextResponse.json({
        success: true,
        emailsReset: 0,
        contactsPreserved: true,
        message: "There is no active Gmail connection to reset.",
      });
    }

    const { error: runError } = await supabase
      .from("tool_runs")
      .update({
        status: "cancelled",
        completed_at: new Date().toISOString(),
        worker_id: null,
        worker_started_at: null,
        worker_lease_expires_at: null,
        sheet_worker_id: null,
        sheet_worker_started_at: null,
        sheet_worker_lease_expires_at: null,
      })
      .in("connection_id", connectionIds)
      .eq("status", "running");

    if (runError) {
      throw new Error(
        "Could not stop active runs: " + runError.message
      );
    }

    // The new processor creates a fresh durable queue for every run.
    // There is no need to mutate historical email_logs or Gmail labels.
    // Existing contacts remain the source of truth for deduplication.
    const { count: queuedJobs, error: jobError } = await supabase
      .from("run_email_jobs")
      .select("id", { count: "exact", head: true })
      .in("connection_id", connectionIds)
      .in("status", ["pending", "processing"]);

    if (jobError) {
      throw new Error(
        "Could not inspect active processing jobs: " + jobError.message
      );
    }

    const { count: sheetJobs, error: sheetJobError } = await supabase
      .from("run_sheet_jobs")
      .select("id", { count: "exact", head: true })
      .in("connection_id", connectionIds)
      .in("status", ["pending", "processing"]);

    if (sheetJobError) {
      throw new Error(
        "Could not inspect active spreadsheet jobs: " +
          sheetJobError.message
      );
    }

    return NextResponse.json({
      success: true,
      emailsReset: (queuedJobs || 0) + (sheetJobs || 0),
      contactsPreserved: true,
      message:
        "Active processing was stopped. The next run will build a fresh Gmail queue, while existing contacts remain preserved for deduplication.",
    });
  } catch (error) {
    console.error("Reset processing state failed", error);

    return NextResponse.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "Unable to reset processing state.",
      },
      { status: 500 }
    );
  }
}
