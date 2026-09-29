import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

function getSheetId(value: string) {
  const trimmed = value.trim();

  const match = trimmed.match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/);
  return match?.[1] ?? trimmed;
}

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null);
  const input = typeof body?.sheetId === "string" ? body.sheetId : "";

  if (!input.trim()) {
    return NextResponse.json(
      { error: "Google Sheet ID or URL is required." },
      { status: 400 }
    );
  }

  const sheetId = getSheetId(input);

  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  );

  const { data: connection, error: lookupError } = await supabase
    .from("google_connections")
    .select("id")
    .eq("is_active", true)
    .limit(1)
    .maybeSingle();

  if (lookupError) {
    return NextResponse.json({ error: lookupError.message }, { status: 500 });
  }

  if (!connection) {
    return NextResponse.json(
      { error: "Connect Gmail before saving a spreadsheet." },
      { status: 400 }
    );
  }

  const { error } = await supabase
    .from("google_connections")
    .update({ target_sheet_id: sheetId })
    .eq("id", connection.id);

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ sheetId });
}
