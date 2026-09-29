import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { google } from "googleapis";
import { getCurrentUser } from "@/lib/auth";

function getSheetId(value: string) {
  const trimmed = value.trim();
  const match = trimmed.match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/);
  return match?.[1] ?? trimmed;
}

async function ensureContactsSheet(
  sheets: ReturnType<typeof google.sheets>,
  spreadsheetId: string
) {
  const spreadsheet = await sheets.spreadsheets.get({
    spreadsheetId: spreadsheetId,
    fields: "sheets.properties",
  });

  const hasContacts = (spreadsheet.data.sheets || []).some(
    (sheet) => sheet.properties?.title === "Contacts"
  );

  if (!hasContacts) {
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: spreadsheetId,
      requestBody: {
        requests: [
          {
            addSheet: {
              properties: {
                title: "Contacts",
              },
            },
          },
        ],
      },
    });

    await sheets.spreadsheets.values.update({
      spreadsheetId: spreadsheetId,
      range: "Contacts!A1:H1",
      valueInputOption: "USER_ENTERED",
      requestBody: {
        values: [[
          "First name",
          "Last name",
          "Email",
          "Phone",
          "Fax",
          "Title",
          "Address",
          "Source",
        ]],
      },
    });
  }
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
    const sheets = google.sheets({ version: "v4", auth });
    await ensureContactsSheet(sheets, sheetId);

    const spreadsheet = await sheets.spreadsheets.get({
      spreadsheetId: sheetId,
      fields: "properties(title,spreadsheetId),spreadsheetUrl",
    });

    title = spreadsheet.data.properties?.title || title;
    spreadsheetUrl = spreadsheet.data.spreadsheetUrl || spreadsheetUrl;
  } catch (error) {
    return NextResponse.json(
      {
        error:
          error instanceof Error
            ? "Could not access that Google Sheet: " + error.message
            : "Could not access that Google Sheet.",
      },
      { status: 400 }
    );
  }

  const { error: updateError } = await supabase
    .from("google_connections")
    .update({ target_sheet_id: sheetId })
    .eq("id", connection.id)
    .eq("user_id", user.id);

  if (updateError) {
    return NextResponse.json({ error: updateError.message }, { status: 500 });
  }

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
