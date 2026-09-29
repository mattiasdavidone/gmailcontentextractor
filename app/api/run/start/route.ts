import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { getCurrentUser } from "@/lib/auth";

export const dynamic = "force-dynamic";

export async function POST() {
  const user = await getCurrentUser();

  if (!user) {
    return NextResponse.json({ error: "AUTH_REQUIRED" }, { status: 401 });
  }

  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  );

  const { data: connection, error: connectionError } = await supabase
    .from("google_connections")
    .select("id, target_sheet_id")
    .eq("user_id", user.id)
    .eq("is_active", true)
    .limit(1)
    .maybeSingle();

  if (connectionError) {
    return NextResponse.json(
      { error: connectionError.message },
      { status: 500 }
    );
  }

  if (!connection?.target_sheet_id) {
    return NextResponse.json(
      { error: "Save a Google Sheet before starting a run." },
      { status: 400 }
    );
  }

  const { data: activeRun, error: activeRunError } = await supabase
    .from("tool_runs")
    .select("id, started_at")
    .eq("user_id", user.id)
    .eq("connection_id", connection.id)
    .eq("status", "running")
    .order("started_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (activeRunError) {
    return NextResponse.json(
      { error: activeRunError.message },
      { status: 500 }
    );
  }

  if (activeRun) {
    const startedAt = new Date(activeRun.started_at).getTime();
    const stale = Date.now() - startedAt > 30 * 60 * 1000;

    if (!stale) {
      return NextResponse.json(
        {
          error: "A Gmail scan is already running.",
          runId: activeRun.id,
        },
        { status: 409 }
      );
    }

    await supabase
      .from("tool_runs")
      .update({
        status: "failed",
        completed_at: new Date().toISOString(),
      })
      .eq("id", activeRun.id)
      .eq("user_id", user.id)
      .eq("status", "running");
  }

  const { data: run, error } = await supabase
    .from("tool_runs")
    .insert({
      user_id: user.id,
      connection_id: connection.id,
      status: "running",
    })
    .select("id")
    .single();

  if (error || !run) {
    if (error?.code === "23505") {
      return NextResponse.json(
        { error: "A Gmail scan is already running." },
        { status: 409 }
      );
    }

    return NextResponse.json(
      { error: error?.message || "Unable to start run." },
      { status: 500 }
    );
  }

  return NextResponse.json({ runId: run.id });
}
