import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { getCurrentUser } from "@/lib/auth";

export const dynamic = "force-dynamic";

function getSupabase() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url || !serviceRoleKey) {
    throw new Error("Supabase environment variables are not configured.");
  }

  return createClient(url, serviceRoleKey);
}

export async function POST() {
  try {
    const user = await getCurrentUser();

    if (!user) {
      return NextResponse.json({ error: "AUTH_REQUIRED" }, { status: 401 });
    }

    const supabase = getSupabase();

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

    const { count, error: logDeleteError } = await supabase
      .from("email_logs")
      .delete({ count: "exact" })
      .in("connection_id", connectionIds);

    if (logDeleteError) {
      throw new Error(
        "Could not clear processing history: " + logDeleteError.message
      );
    }

    const { error: runError } = await supabase
      .from("tool_runs")
      .update({
        status: "cancelled",
        completed_at: new Date().toISOString(),
      })
      .in("connection_id", connectionIds)
      .eq("status", "running");

    if (runError) {
      throw new Error(
        "Could not stop active runs: " + runError.message
      );
    }

    return NextResponse.json({
      success: true,
      emailsReset: count || 0,
      contactsPreserved: true,
      message:
        count && count > 0
          ? "Processing history was cleared. Existing contacts were preserved, so rerunning will not create duplicate contact rows."
          : "Processing history was already clear. Existing contacts were preserved.",
    });
  } catch (error) {
    console.error("Reset processing history failed", error);

    return NextResponse.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "Unable to reset processing history.",
      },
      { status: 500 }
    );
  }
}
