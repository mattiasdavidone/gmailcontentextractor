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
    return NextResponse.json({ error: connectionError.message }, { status: 500 });
  }

  if (!connection?.target_sheet_id) {
    return NextResponse.json(
      { error: "Save a Google Sheet before starting a run." },
      { status: 400 }
    );
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
    return NextResponse.json(
      { error: error?.message || "Unable to start run." },
      { status: 500 }
    );
  }

  return NextResponse.json({ runId: run.id });
}
