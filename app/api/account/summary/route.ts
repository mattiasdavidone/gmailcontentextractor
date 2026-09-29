import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { getCurrentUser } from "@/lib/auth";

export const dynamic = "force-dynamic";

export async function GET() {
  const user = await getCurrentUser();

  if (!user) {
    return NextResponse.json({ error: "AUTH_REQUIRED" }, { status: 401 });
  }

  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  );

  const [
    { data: runs, error: runsError },
    { data: spreadsheets, error: spreadsheetsError },
    { data: connection, error: connectionError },
  ] = await Promise.all([
    supabase
      .from("tool_runs")
      .select(
        "status, emails_scanned, bots_filtered, contacts_extracted, started_at, completed_at"
      )
      .eq("user_id", user.id)
      .order("started_at", { ascending: false }),
    supabase
      .from("linked_spreadsheets")
      .select(
        "spreadsheet_id, title, spreadsheet_url, first_linked_at, last_used_at"
      )
      .eq("user_id", user.id)
      .order("last_used_at", { ascending: false }),
    supabase
      .from("google_connections")
      .select("google_email")
      .eq("user_id", user.id)
      .eq("is_active", true)
      .limit(1)
      .maybeSingle(),
  ]);

  if (runsError || spreadsheetsError || connectionError) {
    return NextResponse.json(
      {
        error:
          runsError?.message ||
          spreadsheetsError?.message ||
          connectionError?.message ||
          "Unable to load account data.",
      },
      { status: 500 }
    );
  }

  const runRows = runs || [];

  return NextResponse.json({
    user: {
      email: user.email,
      createdAt: user.created_at,
    },
    gmail: connection?.google_email || null,
    usage: {
      totalRuns: runRows.length,
      completedRuns: runRows.filter((run) => run.status === "complete").length,
      emailsScanned: runRows.reduce(
        (sum, run) => sum + (run.emails_scanned || 0),
        0
      ),
      botsFiltered: runRows.reduce(
        (sum, run) => sum + (run.bots_filtered || 0),
        0
      ),
      contactsExtracted: runRows.reduce(
        (sum, run) => sum + (run.contacts_extracted || 0),
        0
      ),
    },
    spreadsheets: spreadsheets || [],
    runs: runRows.slice(0, 20),
  });
}
