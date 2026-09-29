import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { google } from "googleapis";
import OpenAI from "openai";

export const maxDuration = 60;
export const dynamic = "force-dynamic";

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

function createSupabase() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  );
}

function parseModelJson(value: string | null | undefined) {
  if (!value) return {};
  try {
    return JSON.parse(value);
  } catch {
    throw new Error("OpenAI returned invalid JSON.");
  }
}

async function checkIfSenderIsHuman(senderRaw: string) {
  const response = await openai.chat.completions.create({
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

  const result = parseModelJson(response.choices[0]?.message?.content);
  return result.is_human === true;
}

async function extractContactDetails(
  senderRaw: string,
  subject: string,
  bodyText: string
) {
  const response = await openai.chat.completions.create({
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

  return parseModelJson(response.choices[0]?.message?.content);
}

async function getScanLabel(gmail: any) {
  const labels = await gmail.users.labels.list({ userId: "me" });
  const existing = (labels.data.labels || []).find(
    (label: any) => label.name === "AI-Scanned"
  );

  if (existing?.id) return existing.id;

  const created = await gmail.users.labels.create({
    userId: "me",
    requestBody: {
      name: "AI-Scanned",
      labelListVisibility: "labelShow",
      messageListVisibility: "show",
    },
  });

  if (!created.data.id) {
    throw new Error("Google did not return a label ID for AI-Scanned.");
  }

  return created.data.id;
}

function errorMessage(error: unknown) {
  if (error instanceof Error) return error.message;

  if (typeof error === "string") return error;

  try {
    return JSON.stringify(error);
  } catch {
    return "Unknown run error.";
  }
}

export async function POST() {
  let stage = "starting";

  try {
    const supabase = createSupabase();

    stage = "loading Gmail connection";

    const { data: connection, error: connectionError } = await supabase
      .from("google_connections")
      .select("*")
      .eq("is_active", true)
      .limit(1)
      .maybeSingle();

    if (connectionError) {
      throw new Error(`Supabase connection lookup failed: ${connectionError.message}`);
    }

    if (!connection) {
      return NextResponse.json(
        { error: "No active Gmail connection found." },
        { status: 400 }
      );
    }

    if (!connection.target_sheet_id) {
      return NextResponse.json(
        { error: "Save a Google Sheet before starting a run." },
        { status: 400 }
      );
    }

    stage = "authorizing Google APIs";

    const auth = new google.auth.OAuth2(
      process.env.GOOGLE_CLIENT_ID,
      process.env.GOOGLE_CLIENT_SECRET
    );

    auth.setCredentials({ refresh_token: connection.refresh_token });

    const gmail = google.gmail({ version: "v1", auth });
    const sheets = google.sheets({ version: "v4", auth });

    stage = "finding next Gmail message";

    const listRes = await gmail.users.messages.list({
      userId: "me",
      q: "in:inbox -label:AI-Scanned",
      maxResults: 1,
    });

    const messageRef = listRes.data.messages?.[0];

    if (!messageRef?.id) {
      return NextResponse.json({
        done: true,
        scanned: 0,
        botsFiltered: 0,
        contactsExtracted: 0,
        activity: "No unprocessed inbox emails found.",
      });
    }

    stage = "reading Gmail message";

    const msg = await gmail.users.messages.get({
      userId: "me",
      id: messageRef.id,
      format: "full",
    });

    const headers = msg.data.payload?.headers || [];
    const fromHeader =
      headers.find((h) => h.name?.toLowerCase() === "from")?.value || "";
    const subject =
      headers.find((h) => h.name?.toLowerCase() === "subject")?.value || "";
    const snippet = msg.data.snippet || "";

    if (!fromHeader) {
      throw new Error("The Gmail message does not contain a From address.");
    }

    stage = "classifying sender";

    stage = "checking scan label";

    const labelId = await getScanLabel(gmail);

    // Make each email step idempotent. If a previous attempt already recorded
    // this message, do not run OpenAI or append to the Sheet a second time.
    const { data: existingLog, error: existingLogError } = await supabase
      .from("email_logs")
      .select("status")
      .eq("connection_id", connection.id)
      .eq("message_id", messageRef.id)
      .maybeSingle();

    if (existingLogError) {
      throw new Error(`Could not check email log: ${existingLogError.message}`);
    }

    if (existingLog?.status) {
      stage = "finishing previously processed email";

      await gmail.users.messages.modify({
        userId: "me",
        id: messageRef.id,
        requestBody: { addLabelIds: [labelId] },
      });

      if (existingLog.status === "bot_filtered") {
        return NextResponse.json({
          done: false,
          scanned: 1,
          botsFiltered: 1,
          contactsExtracted: 0,
          activity: `Already filtered: ${fromHeader}`,
        });
      }

      if (existingLog.status === "contact_extracted") {
        return NextResponse.json({
          done: false,
          scanned: 1,
          botsFiltered: 0,
          contactsExtracted: 1,
          activity: `Already processed: ${fromHeader}`,
        });
      }

      return NextResponse.json({
        done: false,
        scanned: 1,
        botsFiltered: 0,
        contactsExtracted: 0,
        activity: `Already processed email: ${fromHeader}`,
      });
    }

    stage = "classifying sender";

    const isHuman = await checkIfSenderIsHuman(fromHeader);

    if (!isHuman) {
      stage = "recording filtered email";

      const { error: logError } = await supabase
        .from("email_logs")
        .upsert(
          {
            connection_id: connection.id,
            message_id: messageRef.id,
            status: "bot_filtered",
          },
          { onConflict: "connection_id,message_id" }
        );

      if (logError) {
        throw new Error(`Could not write email log: ${logError.message}`);
      }

      stage = "labeling filtered email";

      await gmail.users.messages.modify({
        userId: "me",
        id: messageRef.id,
        requestBody: { addLabelIds: [labelId] },
      });

      return NextResponse.json({
        done: false,
        scanned: 1,
        botsFiltered: 1,
        contactsExtracted: 0,
        activity: `Filtered non-human sender: ${fromHeader}`,
      });
    }

    stage = "extracting contact";

    const contact = await extractContactDetails(fromHeader, subject, snippet);

    stage = "writing contact to Google Sheet";

    await sheets.spreadsheets.values.append({
      spreadsheetId: connection.target_sheet_id,
      range: "Contacts!A:H",
      valueInputOption: "USER_ENTERED",
      requestBody: {
        values: [[
          contact.first_name || "",
          contact.last_name || "",
          contact.email || "",
          contact.phone || "",
          contact.fax || "",
          contact.title || "",
          contact.address || "",
          "",
        ]],
      },
    });

    stage = "saving extracted contact";

    const { error: contactError } = await supabase
      .from("extracted_contacts")
      .insert({
        connection_id: connection.id,
        email: contact.email || "",
        first_name: contact.first_name,
        last_name: contact.last_name,
        phone: contact.phone,
        title: contact.title,
        address: contact.address,
      });

    if (contactError) {
      throw new Error(`Could not save extracted contact: ${contactError.message}`);
    }

    stage = "recording processed email";

    const { error: emailLogError } = await supabase.from("email_logs").insert({
      connection_id: connection.id,
      message_id: messageRef.id,
      status: "contact_extracted",
    });

    if (emailLogError) {
      throw new Error(`Could not write email log: ${emailLogError.message}`);
    }

    stage = "labeling processed email";

    await gmail.users.messages.modify({
      userId: "me",
      id: messageRef.id,
      requestBody: { addLabelIds: [labelId] },
    });

    return NextResponse.json({
      done: false,
      scanned: 1,
      botsFiltered: 0,
      contactsExtracted: 1,
      activity: `Extracted contact from: ${fromHeader}`,
    });
  } catch (error) {
    console.error("Run step failed", { stage, error });

    return NextResponse.json(
      {
        error: `Run failed while ${stage}: ${errorMessage(error)}`,
        stage,
      },
      { status: 500 }
    );
  }
}
