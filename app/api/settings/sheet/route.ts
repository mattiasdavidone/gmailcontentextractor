import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { google } from "googleapis";
import { getCurrentUser } from "@/lib/auth";
import {
  ensureContactsTab,
  normalizeEmail,
  readContactsRows,
} from "@/lib/google-sheets";

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

async function importExistingContacts(
  supabase: any,
  sheets: ReturnType<typeof google.sheets>,
  connectionId: string,
  spreadsheetId: string,
  tabId: number,
  tabName: string
) {
  const rows = await readContactsRows(sheets, spreadsheetId, tabName);
  const sheetWrittenTo = spreadsheetId + ":" + String(tabId);

  const contacts = rows
    .map((row) => ({
      first_name: String(row[0] || "").trim() || null,
      last_name: String(row[1] || "").trim() || null,
      email: normalizeEmail(row[2]),
      phone: String(row[3] || "").trim() || null,
      title: String(row[5] || "").trim() || null,
      address: String(row[6] || "").trim() || null,
      message_id: String(row[8] || "").trim() || null,
    }))
    .filter((row) => row.email);

  if (contacts.length === 0) return 0;

  const payload = contacts.map((contact) => ({
    connection_id: connectionId,
    message_id: contact.message_id,
    run_id: null,
    email: contact.email,
    normalized_email: contact.email,
    first_name: contact.first_name,
    last_name: contact.last_name,
    phone: contact.phone,
    title: contact.title,
    address: contact.address,
    sheet_written: true,
    sheet_written_to: sheetWrittenTo,
  }));

  const { error } = await supabase
    .from("extracted_contacts")
    .upsert(payload, {
      onConflict: "connection_id,normalized_email",
      ignoreDuplicates: false,
    });

  if (error) {
    throw new Error(
      "The spreadsheet was linked, but existing contacts could not be imported: " +
        error.message
    );
  }

  return contacts.length;
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

  if (!/^[a-zA-Z0-9_-]{20,200}$/.test(sheetId)) {
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
    .select(
      "id, google_email, refresh_token, target_sheet_id, target_sheet_tab_id, target_sheet_tab_name"
    )
    .eq("user_id", user.id)
    .eq("is_active", true)
    .limit(1)
    .maybeSingle();

  if (lookupError) {
    return NextResponse.json(
      { error: lookupError.message },
      { status: 500 }
    );
  }

  if (!connection) {
    return NextResponse.json(
      { error: "Connect Gmail before saving a spreadsheet." },
      { status: 400 }
    );
  }

  const { data: activeRun, error: activeRunError } = await supabase
    .from("tool_runs")
    .select("id")
    .eq("user_id", user.id)
    .eq("connection_id", connection.id)
    .eq("status", "running")
    .limit(1)
    .maybeSingle();

  if (activeRunError) {
    return NextResponse.json(
      { error: activeRunError.message },
      { status: 500 }
    );
  }

  if (activeRun) {
    return NextResponse.json(
      {
        error:
          "Stop the current Gmail scan before changing the Google Sheet destination.",
      },
      { status: 409 }
    );
  }

  const auth = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET
  );

  auth.setCredentials({ refresh_token: connection.refresh_token });

  try {
    // Saving the same spreadsheet again is a no-op. The run engine already
    // has the validated Contacts tab stored on the connection, so avoid
    // another workbook/header/data read and avoid burning Sheets quota.
    if (
      connection.target_sheet_id === sheetId &&
      typeof connection.target_sheet_tab_id === "number" &&
      connection.target_sheet_tab_name
    ) {
      const { data: linked } = await supabase
        .from("linked_spreadsheets")
        .select("title, spreadsheet_url")
        .eq("user_id", user.id)
        .eq("spreadsheet_id", sheetId)
        .limit(1)
        .maybeSingle();

      await supabase
        .from("linked_spreadsheets")
        .update({ last_used_at: new Date().toISOString() })
        .eq("user_id", user.id)
        .eq("spreadsheet_id", sheetId);

      return NextResponse.json({
        sheetId,
        title: linked?.title || "Google Sheet",
        spreadsheetUrl:
          linked?.spreadsheet_url ||
          "https://docs.google.com/spreadsheets/d/" + sheetId + "/edit",
        tabName: connection.target_sheet_tab_name,
        importedContacts: 0,
        reused: true,
      });
    }

    const sheets = google.sheets({ version: "v4", auth });

    const contactsTab = await ensureContactsTab(
      sheets,
      sheetId,
      connection.target_sheet_id === sheetId
        ? connection.target_sheet_tab_id
        : null,
      connection.target_sheet_id === sheetId
        ? connection.target_sheet_tab_name
        : null
    );

    if (
      typeof contactsTab.tabId !== "number" ||
      typeof contactsTab.title !== "string"
    ) {
      throw new Error("Google did not return a valid Contacts tab.");
    }

    const imported = await importExistingContacts(
      supabase,
      sheets,
      connection.id,
      sheetId,
      contactsTab.tabId,
      contactsTab.title
    );

    const { error: updateError } = await supabase
      .from("google_connections")
      .update({
        target_sheet_id: sheetId,
        target_sheet_tab_id: contactsTab.tabId,
        target_sheet_tab_name: contactsTab.title,
      })
      .eq("id", connection.id)
      .eq("user_id", user.id);

    if (updateError) {
      throw new Error(
        "The spreadsheet was checked, but the active tab could not be saved: " +
          updateError.message
      );
    }

    const { error: historyError } = await supabase
      .from("linked_spreadsheets")
      .upsert(
        {
          user_id: user.id,
          spreadsheet_id: sheetId,
          title: contactsTab.spreadsheetTitle,
          spreadsheet_url: contactsTab.spreadsheetUrl,
          last_used_at: new Date().toISOString(),
        },
        { onConflict: "user_id,spreadsheet_id" }
      );

    if (historyError) {
      throw new Error(
        "The spreadsheet was linked, but its account history could not be saved: " +
          historyError.message
      );
    }

    return NextResponse.json({
      sheetId,
      title: contactsTab.spreadsheetTitle,
      spreadsheetUrl: contactsTab.spreadsheetUrl,
      tabName: contactsTab.title,
      importedContacts: imported,
      reused: false,
      created: contactsTab.created === true,
    });
  } catch (error) {
    console.error("Google Sheet save failed", {
      userId: user.id,
      sheetId,
      error,
    });

    const message = getGoogleError(error);
    const lower = message.toLowerCase();

    if (
      lower.includes("invalid_grant") ||
      lower.includes("invalid grant") ||
      lower.includes("unauthorized") ||
      lower.includes("token")
    ) {
      return NextResponse.json(
        {
          error:
            "Google authorization is no longer valid. Click Reconnect and approve Gmail and Google Sheets access again.",
        },
        { status: 401 }
      );
    }

    if (message.includes("429") || lower.includes("quota")) {
      return NextResponse.json(
        {
          error:
            "Google Sheets is temporarily rate-limiting this operation. Wait a few seconds and try again.",
          quotaLimited: true,
          retryable: true,
          retryAfterSeconds: 5,
        },
        {
          status: 429,
          headers: { "Retry-After": "5" },
        }
      );
    }

    if (
      lower.includes("permission") ||
      lower.includes("forbidden") ||
      lower.includes("not found")
    ) {
      return NextResponse.json(
        {
          error:
            "Google could not access that spreadsheet. Make sure the spreadsheet is owned by or shared with " +
            (connection.google_email || user.email) +
            ", then paste the full Google Sheets link again.",
        },
        { status: 400 }
      );
    }

    return NextResponse.json(
      {
        error: "Google Sheets rejected the spreadsheet link: " + message,
      },
      { status: 400 }
    );
  }
}
