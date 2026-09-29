import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { google } from "googleapis";
import OpenAI from "openai";
import { getCurrentUser } from "@/lib/auth";
import {
  extractEmailAddress,
  findExistingContactInSpreadsheet,
  getTargetContactsTab,
} from "@/lib/google-sheets";

export const maxDuration = 60;
export const dynamic = "force-dynamic";

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

function createSupabase() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY
  );
}

class RunCancelledError extends Error {
  constructor() {
    super("RUN_CANCELLED");
  }
}

async function assertRunActive(
  supabase,
  runId,
  userId
) {
  const { data, error } = await supabase
    .from("tool_runs")
    .select("status")
    .eq("id", runId)
    .eq("user_id", userId)
    .maybeSingle();

  if (error) {
    throw new Error("Could not check run status: " + error.message);
  }

  if (!data || data.status !== "running") {
    throw new RunCancelledError();
  }
}

function errorMessage(error) {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;

  try {
    return JSON.stringify(error);
  } catch {
    return "Unknown run error.";
  }
}

function parseJson(value) {
  if (!value) return {};

  try {
    return JSON.parse(value);
  } catch {
    throw new Error("OpenAI returned invalid JSON.");
  }
}

async function classifySender(sender) {
  const response = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [
      {
        role: "system",
        content:
          'Analyze the sender email address. Return strictly JSON: {"is_human": boolean}.',
      },
      {
        role: "user",
        content: "Sender: " + sender,
      },
    ],
    response_format: { type: "json_object" },
    temperature: 0,
  });

  const parsed = parseJson(response.choices[0]?.message?.content);
  return parsed.is_human === true;
}

async function extractContact(
  sender,
  subject,
  snippet
) {
  const response = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [
      {
        role: "system",
        content:
          "Extract contact details from the email. Return JSON with keys: first_name, last_name, email, phone, fax, title, address.",
      },
      {
        role: "user",
        content:
          "Sender: " +
          sender +
          "\nSubject: " +
          subject +
          "\nBody: " +
          snippet,
      },
    ],
    response_format: { type: "json_object" },
    temperature: 0.1,
  });

  return parseJson(response.choices[0]?.message?.content);
}

async function getScanLabel(gmail) {
  const response = await gmail.users.labels.list({ userId: "me" });
  const label = (response.data.labels || []).find(
    (item) => item.name === "AI-Scanned"
  );

  if (label?.id) return label.id;

  const created = await gmail.users.labels.create({
    userId: "me",
    requestBody: {
      name: "AI-Scanned",
      labelListVisibility: "labelShow",
      messageListVisibility: "show",
    },
  });

  if (!created.data.id) {
    throw new Error("Google did not return the AI-Scanned label ID.");
  }

  return created.data.id;
}

async function incrementRun(
  supabase,
  runId,
  userId,
  delta
) {
  const { data, error } = await supabase
    .from("tool_runs")
    .select("emails_scanned, bots_filtered, contacts_extracted")
    .eq("id", runId)
    .eq("user_id", userId)
    .single();

  if (error) {
    throw new Error("Could not load run totals: " + error.message);
  }

  const { error: updateError } = await supabase
    .from("tool_runs")
    .update({
      emails_scanned: (data.emails_scanned || 0) + (delta.scanned || 0),
      bots_filtered: (data.bots_filtered || 0) + (delta.filtered || 0),
      contacts_extracted:
        (data.contacts_extracted || 0) + (delta.contacts || 0),
    })
    .eq("id", runId)
    .eq("user_id", userId);

  if (updateError) {
    throw new Error("Could not update run totals: " + updateError.message);
  }
}

async function recordEmail(
  supabase,
  connectionId,
  runId,
  messageId,
  status
) {
  const { error } = await supabase
    .from("email_logs")
    .upsert(
      {
        connection_id: connectionId,
        run_id: runId,
        message_id: messageId,
        status,
      },
      { onConflict: "connection_id,message_id" }
    );

  if (error) {
    throw new Error("Could not write email log: " + error.message);
  }
}

async function markLabel(gmail, messageId, labelId) {
  await gmail.users.messages.modify({
    userId: "me",
    id: messageId,
    requestBody: {
      addLabelIds: [labelId],
    },
  });
}

async function appendContact(
  sheets,
  spreadsheetId,
  tabName,
  contact
) {
  const safeTitle = tabName.replace(/'/g, "''");

  await sheets.spreadsheets.values.append({
    spreadsheetId,
    range: "'" + safeTitle + "'!A:H",
    valueInputOption: "USER_ENTERED",
    requestBody: {
      values: [
        [
          contact.first_name || "",
          contact.last_name || "",
          contact.email || "",
          contact.phone || "",
          "",
          contact.title || "",
          contact.address || "",
          contact.source,
        ],
      ],
    },
  });
}

export async function POST(req) {
  let stage = "starting";
  let runId = "";

  const user = await getCurrentUser();

  if (!user) {
    return NextResponse.json({ error: "AUTH_REQUIRED" }, { status: 401 });
  }

  const body = await req.json().catch(() => null);
  runId = typeof body?.runId === "string" ? body.runId : "";

  if (!runId) {
    return NextResponse.json(
      { error: "runId is required." },
      { status: 400 }
    );
  }

  try {
    const supabase = createSupabase();

    stage = "loading run";

    const { data: run, error: runError } = await supabase
      .from("tool_runs")
      .select("id, connection_id, status")
      .eq("id", runId)
      .eq("user_id", user.id)
      .maybeSingle();

    if (runError) {
      throw new Error("Could not load run: " + runError.message);
    }

    if (!run) {
      return NextResponse.json({ error: "Run not found." }, { status: 404 });
    }

    if (run.status !== "running") {
      return NextResponse.json(
        { error: "This run is no longer active." },
        { status: 409 }
      );
    }

    stage = "loading Gmail connection";

    const { data: connection, error: connectionError } = await supabase
      .from("google_connections")
      .select("*")
      .eq("id", run.connection_id)
      .eq("user_id", user.id)
      .eq("is_active", true)
      .maybeSingle();

    if (connectionError) {
      throw new Error(
        "Could not load Gmail connection: " + connectionError.message
      );
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

    await assertRunActive(supabase, runId, user.id);

    stage = "authorizing Google";

    const auth = new google.auth.OAuth2(
      process.env.GOOGLE_CLIENT_ID,
      process.env.GOOGLE_CLIENT_SECRET
    );

    auth.setCredentials({ refresh_token: connection.refresh_token });

    const gmail = google.gmail({
      version: "v1",
      auth,
    });

    const sheets = google.sheets({
      version: "v4",
      auth,
    });

    stage = "checking Contacts tab";

    const contactsTab = await getTargetContactsTab(
      sheets,
      connection.target_sheet_id,
      connection.target_sheet_tab_id,
      connection.target_sheet_tab_name
    );

    if (
      connection.target_sheet_tab_id !== contactsTab.tabId ||
      connection.target_sheet_tab_name !== contactsTab.title
    ) {
      const { error: tabError } = await supabase
        .from("google_connections")
        .update({
          target_sheet_tab_id: contactsTab.tabId,
          target_sheet_tab_name: contactsTab.title,
        })
        .eq("id", connection.id)
        .eq("user_id", user.id);

      if (tabError) {
        throw new Error(
          "Could not save the Contacts tab: " + tabError.message
        );
      }
    }

    await assertRunActive(supabase, runId, user.id);

    stage = "finding next Gmail message";

    const listResponse = await gmail.users.messages.list({
      userId: "me",
      q: "in:inbox -label:AI-Scanned",
      maxResults: 1,
    });

    const messageId = listResponse.data.messages?.[0]?.id;

    if (!messageId) {
      await supabase
        .from("tool_runs")
        .update({
          status: "complete",
          completed_at: new Date().toISOString(),
        })
        .eq("id", runId)
        .eq("user_id", user.id);

      return NextResponse.json({
        done: true,
        scanned: 0,
        botsFiltered: 0,
        contactsExtracted: 0,
        activity: "No unprocessed inbox emails found.",
      });
    }

    await assertRunActive(supabase, runId, user.id);

    stage = "reading Gmail message";

    const message = await gmail.users.messages.get({
      userId: "me",
      id: messageId,
      format: "full",
    });

    const headers = message.data.payload?.headers || [];
    const fromHeader =
      headers.find((header) => header.name?.toLowerCase() === "from")
        ?.value || "";
    const subject =
      headers.find((header) => header.name?.toLowerCase() === "subject")
        ?.value || "";
    const snippet = message.data.snippet || "";

    if (!fromHeader) {
      throw new Error("The Gmail message does not contain a From address.");
    }

    stage = "getting scan label";
    const labelId = await getScanLabel(gmail);

    stage = "checking email history";

    const { data: existingLog, error: existingLogError } = await supabase
      .from("email_logs")
      .select("status")
      .eq("connection_id", connection.id)
      .eq("message_id", messageId)
      .maybeSingle();

    if (existingLogError) {
      throw new Error(
        "Could not check email history: " + existingLogError.message
      );
    }

    if (existingLog?.status === "bot_filtered") {
      await markLabel(gmail, messageId, labelId);
      await incrementRun(supabase, runId, user.id, {
        scanned: 1,
        filtered: 1,
      });

      return NextResponse.json({
        done: false,
        scanned: 1,
        botsFiltered: 1,
        contactsExtracted: 0,
        activity: "Already filtered: " + fromHeader,
      });
    }

    if (existingLog?.status === "contact_already_in_sheet") {
      await markLabel(gmail, messageId, labelId);
      await incrementRun(supabase, runId, user.id, {
        scanned: 1,
      });

      return NextResponse.json({
        done: false,
        scanned: 1,
        botsFiltered: 0,
        contactsExtracted: 0,
        activity: "Already in spreadsheet: " + fromHeader,
      });
    }

    const senderEmail = extractEmailAddress(fromHeader);

    stage = "checking spreadsheet for existing contact";

    const sheetMatchBeforeExtraction = await findExistingContactInSpreadsheet(
      sheets,
      connection.target_sheet_id,
      { email: senderEmail }
    );

    if (sheetMatchBeforeExtraction.found) {
      await assertRunActive(supabase, runId, user.id);

      stage = "recording spreadsheet duplicate";

      await recordEmail(
        supabase,
        connection.id,
        runId,
        messageId,
        "contact_already_in_sheet"
      );

      await markLabel(gmail, messageId, labelId);

      await incrementRun(supabase, runId, user.id, {
        scanned: 1,
      });

      return NextResponse.json({
        done: false,
        scanned: 1,
        botsFiltered: 0,
        contactsExtracted: 0,
        activity: "Already in spreadsheet: " + fromHeader,
      });
    }

    await assertRunActive(supabase, runId, user.id);

    stage = "classifying sender";

    const human = await classifySender(fromHeader);

    if (!human) {
      stage = "recording filtered email";

      await recordEmail(
        supabase,
        connection.id,
        runId,
        messageId,
        "bot_filtered"
      );

      await markLabel(gmail, messageId, labelId);

      await incrementRun(supabase, runId, user.id, {
        scanned: 1,
        filtered: 1,
      });

      return NextResponse.json({
        done: false,
        scanned: 1,
        botsFiltered: 1,
        contactsExtracted: 0,
        activity: "Filtered non-human sender: " + fromHeader,
      });
    }

    await assertRunActive(supabase, runId, user.id);

    stage = "extracting contact";

    const extracted = await extractContact(fromHeader, subject, snippet);

    const extractedEmail =
      typeof extracted.email === "string" && extracted.email.trim()
        ? extracted.email.trim().toLowerCase()
        : senderEmail;

    const candidate = {
      firstName: extracted.first_name || null,
      lastName: extracted.last_name || null,
      email: extractedEmail || null,
      phone: extracted.phone || null,
    };

    stage = "checking spreadsheet after extraction";

    const sheetMatchAfterExtraction = await findExistingContactInSpreadsheet(
      sheets,
      connection.target_sheet_id,
      candidate
    );

    if (sheetMatchAfterExtraction.found) {
      await recordEmail(
        supabase,
        connection.id,
        runId,
        messageId,
        "contact_already_in_sheet"
      );

      await markLabel(gmail, messageId, labelId);

      await incrementRun(supabase, runId, user.id, {
        scanned: 1,
      });

      return NextResponse.json({
        done: false,
        scanned: 1,
        botsFiltered: 0,
        contactsExtracted: 0,
        activity: "Already in spreadsheet after extraction: " + fromHeader,
      });
    }

    await assertRunActive(supabase, runId, user.id);

    stage = "saving extracted contact";

    const { data: savedContact, error: contactError } = await supabase
      .from("extracted_contacts")
      .upsert(
        {
          connection_id: connection.id,
          message_id: messageId,
          run_id: runId,
          email: extractedEmail || "",
          first_name: extracted.first_name || null,
          last_name: extracted.last_name || null,
          phone: extracted.phone || null,
          title: extracted.title || null,
          address: extracted.address || null,
          sheet_written: false,
          sheet_written_to: null,
        },
        { onConflict: "connection_id,message_id" }
      )
      .select(
        "id, email, first_name, last_name, phone, title, address, sheet_written"
      )
      .single();

    if (contactError || !savedContact) {
      throw new Error(
        "Could not save extracted contact: " +
          (contactError?.message || "No contact row returned.")
      );
    }

    await assertRunActive(supabase, runId, user.id);

    stage = "writing contact to Google Sheet";

    await appendContact(
      sheets,
      connection.target_sheet_id,
      contactsTab.title,
      {
        first_name: savedContact.first_name,
        last_name: savedContact.last_name,
        email: savedContact.email,
        phone: savedContact.phone,
        title: savedContact.title,
        address: savedContact.address,
        source: fromHeader,
      }
    );

    await assertRunActive(supabase, runId, user.id);

    stage = "marking contact written";

    const { error: markError } = await supabase
      .from("extracted_contacts")
      .update({
        sheet_written: true,
        sheet_written_to:
          connection.target_sheet_id + ":" + String(contactsTab.tabId),
      })
      .eq("id", savedContact.id)
      .eq("connection_id", connection.id);

    if (markError) {
      throw new Error("Could not mark contact as written: " + markError.message);
    }

    await assertRunActive(supabase, runId, user.id);

    stage = "recording processed email";

    await recordEmail(
      supabase,
      connection.id,
      runId,
      messageId,
      "contact_extracted"
    );

    await markLabel(gmail, messageId, labelId);

    await incrementRun(supabase, runId, user.id, {
      scanned: 1,
      contacts: 1,
    });

    return NextResponse.json({
      done: false,
      scanned: 1,
      botsFiltered: 0,
      contactsExtracted: 1,
      activity: "Extracted contact from: " + fromHeader,
    });
  } catch (error) {
    if (error instanceof RunCancelledError) {
      return NextResponse.json({
        done: true,
        stopped: true,
        scanned: 0,
        botsFiltered: 0,
        contactsExtracted: 0,
        activity: "Run stopped.",
      });
    }

    console.error("Run step failed", {
      runId,
      stage,
      error,
    });

    const message = errorMessage(error);
    const supabase = createSupabase();

    if (runId) {
      await supabase
        .from("tool_runs")
        .update({
          status: "failed",
          completed_at: new Date().toISOString(),
        })
        .eq("id", runId)
        .eq("user_id", user.id)
        .then(() => undefined)
        .catch(() => undefined);
    }

    const lower = message.toLowerCase();

    if (
      lower.includes("invalid_grant") ||
      lower.includes("invalid grant") ||
      lower.includes("token has been expired") ||
      lower.includes("token has been revoked")
    ) {
      if (runId) {
        const { data: failedRun } = await supabase
          .from("tool_runs")
          .select("connection_id")
          .eq("id", runId)
          .eq("user_id", user.id)
          .maybeSingle();

        if (failedRun?.connection_id) {
          await supabase
            .from("google_connections")
            .update({ is_active: false })
            .eq("id", failedRun.connection_id)
            .eq("user_id", user.id);
        }
      }

      return NextResponse.json(
        {
          error:
            "Your Google authorization has expired or been revoked. Reconnect Gmail and approve access again.",
          authRequired: true,
        },
        { status: 401 }
      );
    }

    return NextResponse.json(
      {
        error: "Run failed while " + stage + ": " + message,
        stage,
      },
      { status: 500 }
    );
  }
}
