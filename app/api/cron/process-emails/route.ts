import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { google } from "googleapis";
import OpenAI from "openai";

function getSupabase() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url || !serviceRoleKey) {
    throw new Error("Supabase environment variables are not configured.");
  }

  return createClient(url, serviceRoleKey);
}

let openaiClient: OpenAI | null = null;

function getOpenAI() {
  if (!openaiClient) {
    const apiKey = process.env.OPENAI_API_KEY;

    if (!apiKey) {
      throw new Error("OPENAI_API_KEY is not configured.");
    }

    openaiClient = new OpenAI({ apiKey });
  }

  return openaiClient;
}

export async function POST(req: NextRequest) {
  // VERIFY CRON SECRET
  const authHeader = req.headers.get("authorization");
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "UNAUTHORIZED" }, { status: 401 });
  }

  try {
    const supabase = getSupabase();

    // 1. FETCH ALL ACTIVE CONNECTIONS FROM SUPABASE
    const { data: connections, error } = await supabase
      .from("google_connections")
      .select("*")
      .eq("is_active", true);

    if (error || !connections) {
      return NextResponse.json({ error: "DATABASE ERROR" }, { status: 500 });
    }

    for (const conn of connections) {
      await processUserInbox(conn);
    }

    return NextResponse.json({ status: "SUCCESS", processed: connections.length });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}

async function processUserInbox(connection: any) {
  const auth = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET
  );
  auth.setCredentials({ refresh_token: connection.refresh_token });

  const gmail = google.gmail({ version: "v1", auth });
  const sheets = google.sheets({ version: "v4", auth });

  // FETCH UN-PROCESSED MESSAGES
  const listRes = await gmail.users.messages.list({
    userId: "me",
    q: "in:inbox -label:AI-Scanned",
    maxResults: 25,
  });

  const messages = listRes.data.messages || [];

  for (const msgRef of messages) {
    if (!msgRef.id) continue;

    const msg = await gmail.users.messages.get({
      userId: "me",
      id: msgRef.id,
      format: "full",
    });

    const headers = msg.data.payload?.headers || [];
    const fromHeader = headers.find((h) => h.name?.toLowerCase() === "from")?.value || "";
    const subject = headers.find((h) => h.name?.toLowerCase() === "subject")?.value || "";
    const snippet = msg.data.snippet || "";

    // STAGE 1: CHECK IF SENDER IS HUMAN
    const isHuman = await checkIfSenderIsHuman(fromHeader);

    if (!isHuman) {
      await getSupabase().from("email_logs").insert({
        connection_id: connection.id,
        message_id: msgRef.id,
        status: "bot_filtered",
      });
      continue;
    }

    // STAGE 2: EXTRACT CONTACT DETAILS
    const contact = await extractContactDetails(fromHeader, subject, snippet);

    if (contact && connection.target_sheet_id) {
      // APPEND TO GOOGLE SHEET
      await sheets.spreadsheets.values.append({
        spreadsheetId: connection.target_sheet_id,
        range: "Contacts!A:H",
        valueInputOption: "USER_ENTERED",
        requestBody: {
          values: [
            [
              contact.first_name || "",
              contact.last_name || "",
              contact.email || "",
              contact.phone || "",
              contact.fax || "",
              contact.title || "",
              contact.address || "",
              "",
            ],
          ],
        },
      });

      await getSupabase().from("extracted_contacts").insert({
        connection_id: connection.id,
        email: contact.email || "",
        first_name: contact.first_name,
        last_name: contact.last_name,
        phone: contact.phone,
        title: contact.title,
        address: contact.address,
      });
    }

    await getSupabase().from("email_logs").insert({
      connection_id: connection.id,
      message_id: msgRef.id,
      status: "contact_extracted",
    });
  }
}

async function checkIfSenderIsHuman(senderRaw: string): Promise<boolean> {
  const response = await getOpenAI().chat.completions.create({
    model: "gpt-4o-mini",
    messages: [
      {
        role: "system",
        content:
          "Analyze the sender email address. Return strictly JSON with { is_human: boolean }.",
      },
      { role: "user", content: `Sender: ${senderRaw}` },
    ],
    response_format: { type: "json_object" },
    temperature: 0,
  });

  const res = JSON.parse(response.choices[0].message.content || "{}");
  return res.is_human === true;
}

async function extractContactDetails(
  senderRaw: string,
  subject: string,
  bodyText: string
) {
  const response = await getOpenAI().chat.completions.create({
    model: "gpt-4o-mini",
    messages: [
      {
        role: "system",
        content:
          "Extract contact details from email text. Return JSON with keys: first_name, last_name, email, phone, fax, title, address.",
      },
      {
        role: "user",
        content: `Sender: ${senderRaw}\nSubject: ${subject}\nBody: ${bodyText}`,
      },
    ],
    response_format: { type: "json_object" },
    temperature: 0.1,
  });

  return JSON.parse(response.choices[0].message.content || "{}");
}
