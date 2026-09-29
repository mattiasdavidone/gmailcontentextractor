import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { google } from "googleapis";
import { getCurrentUser } from "@/lib/auth";
import { createContactsTab } from "@/lib/google-sheets";

function getSheetId(value: string) {
  const trimmed = value.trim();

  try {
    const url = new URL(trimmed);

    if (url.hostname !== "docs.google.com") {
      return trimmed;
    }

    const match = url.pathname.match(
      /^\/spreadsheets\/d\/([a-zA-Z0-9-_]+)(?:\/|$)/
    );

    return match?.[1] ?? trimmed;
  } catch {
    return trimmed;
  }
}

function getGoogleError(error: any) {
  return (
    error?.response?.data?.error?.message ||
    error?.errors?.[0]?.message ||
    error?.message ||
    "Google Sheets rejected the request."
  );
}

export async function POST(req: NextRequest) {
  const user = await getCurrentUser();

  if (!user) {
    return NextResponse.json({ error: "AUTH_REQUIRED" }, { status: 401 });
  }

  const body = await req.json().catch(() => null);
  const input = typeof body?.sheetId === "string" ? body.sheetId : "";

  if (!input.trim()) {
    return NextResponse.json(
      { error: "Google Sheet ID or URL is required." },
      { status: 400 }
    );
  }

  const sheetId = getSheetId(input);

  if (
    !/^[a-zA-Z0-9_-]{20,200}$/.test(sheetId)
  ) {
    return NextResponse.json(
      {
        error:
          "That does not look like a valid Google Sheets URL or spreadsheet ID. Paste the full Google Sheets URL.",
      },
      { status: 400 }
    );
  }

  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  );

  const { data: connection, error: lookupError } = await supabase
    .from("google_connections")
    .select("id, google_email, refresh_token")
    .eq("user_id", user.id)
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

  const auth = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET
  );

  auth.setCredentials({ refresh_token: connection.refresh_token });

  let title = "Google Sheet";
  let spreadsheetUrl =
    "https://docs.google.com/spreadsheets/d/" + sheetId + "/edit";

  try {
    const token = await auth.getAccessToken();

    if (!token.token) {
      throw new Error(
        "Google did not return an access token. Reconnect Gmail and approve Google Sheets access."
      );
    }

    const sheets = google.sheets({ version: "v4", auth });

    const spreadsheet = await sheets.spreadsheets.get({
      spreadsheetId: sheetId,
      fields: "spreadsheetId,spreadsheetUrl,properties(title)",
    });

    title = spreadsheet.data.properties?.title || title;
    spreadsheetUrl = spreadsheet.data.spreadsheetUrl || spreadsheetUrl;

    const contactsTab = await createContactsTab(sheets, sheetId);

    const { error: historyError } = await supabase
    .from("linked_spreadsheets")
    .upsert(
      {
        user_id: user.id,
        spreadsheet_id: sheetId,
        title,
        spreadsheet_url: spreadsheetUrl,
        last_used_at: new Date().toISOString(),
      },
      { onConflict: "user_id,spreadsheet_id" }
    );

  if (historyError) {
    return NextResponse.json({ error: historyError.message }, { status: 500 });
  }

  return NextResponse.json({ sheetId, title, spreadsheetUrl });
}
