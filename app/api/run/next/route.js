import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { google } from "googleapis";
import OpenAI from "openai";
import { getCurrentUser } from "@/lib/auth";
import {
  appendContact,
  ensureContactsTab,
  extractEmailAddress,
  hasMessageIdInSheet,
  normalizeEmail,
} from "@/lib/google-sheets";

export const maxDuration = 60;
export const dynamic = "force-dynamic";

let openaiClient;

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

function createSupabase() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url || !serviceRoleKey) {
    throw new Error("Supabase environment variables are not configured.");
  }

  return createClient(url, serviceRoleKey);
}

class RunCancelledError extends Error {
  constructor() {
    super("RUN_CANCELLED");
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

function isGoogleQuotaError(error) {
  const code = Number(
    error?.code ?? error?.response?.status ?? error?.status ?? 0
  );
  return code === 429 || code === 503;
}

function isGoogleAuthError(error) {
  const status = Number(
    error?.code ?? error?.response?.status ?? error?.status ?? 0
  );

  const message = errorMessage(error).toLowerCase();

  return (
    status === 401 ||
    message.includes("invalid_grant") ||
    message.includes("invalid grant") ||
    message.includes("token has been expired") ||
    message.includes("token has been revoked")
  );
}

function parseJson(value) {
  if (!value) return {};

  try {
    return JSON.parse(value);
  } catch {
    throw new Error("OpenAI returned invalid JSON.");
  }
}

async function assertRunActive(supabase, runId, userId) {
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

async function incrementRun(supabase, runId, userId, delta) {
  const { data, error } = await supabase.rpc("increment_tool_run_stats", {
    p_run_id: runId,
    p_user_id: userId,
    p_scanned: delta.scanned || 0,
    p_filtered: delta.filtered || 0,
    p_contacts: delta.contacts || 0,
  });

  if (error || data !== true) {
    throw new Error(
      "Could not update run totals: " + (error?.message || "run was not found.")
    );
  }
}

async function setEmailStatus(
  supabase,
  connectionId,
  messageId,
  runId,
  status
) {
  const { data, error } = await supabase.rpc(
    "set_email_processing_status",
    {
      p_connection_id: connectionId,
      p_message_id: messageId,
      p_run_id: runId,
      p_status: status,
    }
  );

  if (error || data !== true) {
    throw new Error(
      "Could not update email processing status: " +
        (error?.message || "email claim was not found.")
    );
  }
}

async function claimEmail(supabase, connectionId, messageId, runId) {
  const { data, error } = await supabase.rpc("claim_email_processing", {
    p_connection_id: connectionId,
    p_message_id: messageId,
    p_run_id: runId,
  });

  if (error) {
    throw new Error("Could not claim email for processing: " + error.message);
  }

  const result = Array.isArray(data) ? data[0] : data;

  return {
    claimed: result?.claimed === true,
    status: result?.current_status || null,
  };
}

async function classifySender(sender) {
  const response = await getOpenAI().chat.completions.create({
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

async function extractContact(sender, subject, snippet) {
  const response = await getOpenAI().chat.completions.create({
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

async function listNextCandidateMessage(gmail, supabase, connectionId) {
  let pageToken;

  for (let page = 0; page < 10; page += 1) {
    const response = await gmail.users.messages.list({
      userId: "me",
      q: "in:inbox",
      maxResults: 100,
      pageToken,
    });

    const ids = (response.data.messages || [])
      .map((message) => message.id)
      .filter(Boolean);

    if (ids.length === 0) {
      return null;
    }

    const { data: logs, error } = await supabase
      .from("email_logs")
      .select("message_id, status, processed_at")
      .eq("connection_id", connectionId)
      .in("message_id", ids);

    if (error) {
      throw new Error("Could not load email processing history: " + error.message);
    }

    const logMap = new Map(
      (logs || []).map((log) => [
        log.message_id,
        {
          status: log.status,
          processedAt: log.processed_at
            ? new Date(log.processed_at).getTime()
            : 0,
        },
      ])
    );

    const now = Date.now();

    for (const id of ids) {
      const log = logMap.get(id);

      if (!log) {
        return id;
      }

      if (log.status === "failed") {
        return id;
      }

      if (
        log.status === "processing" &&
        log.processedAt > 0 &&
        now - log.processedAt > 10 * 60 * 1000
      ) {
        return id;
      }
    }

    pageToken = response.data.nextPageToken || undefined;

    if (!pageToken) {
      return null;
    }
  }

  return null;
}

async function loadMessage(gmail, messageId) {
  return gmail.users.messages.get({
    userId: "me",
    id: messageId,
    format: "metadata",
    metadataHeaders: ["From", "Subject"],
  });
}

async function findExistingContactByEmail(
  supabase,
  connectionId,
  email
) {
  const normalized = normalizeEmail(email);

  if (!normalized) return null;

  const { data, error } = await supabase
    .from("extracted_contacts")
    .select(
      "id, email, first_name, last_name, phone, title, address, normalized_email, sheet_written, sheet_written_to, message_id"
    )
    .eq("connection_id", connectionId)
    .eq("normalized_email", normalized)
    .limit(1)
    .maybeSingle();

  if (error) {
    throw new Error(
      "Could not check existing contacts: " + error.message
    );
  }

  return data || null;
}

async function findContactForMessage(
  supabase,
  connectionId,
  messageId
) {
  const { data, error } = await supabase
    .from("extracted_contacts")
    .select(
      "id, email, first_name, last_name, phone, title, address, normalized_email, sheet_written, sheet_written_to, message_id"
    )
    .eq("connection_id", connectionId)
    .eq("message_id", messageId)
    .limit(1)
    .maybeSingle();

  if (error) {
    throw new Error(
      "Could not load the existing extracted contact: " + error.message
    );
  }

  return data || null;
}

async function saveExtractedContact(
  supabase,
  connectionId,
  runId,
  messageId,
  contact
) {
  const email = normalizeEmail(contact.email || "");

  const payload = {
    connection_id: connectionId,
    message_id: messageId,
    run_id: runId,
    email,
    normalized_email: email || null,
    first_name: contact.first_name || null,
    last_name: contact.last_name || null,
    phone: contact.phone || null,
    title: contact.title || null,
    address: contact.address || null,
    sheet_written: false,
    sheet_written_to: null,
  };

  const { data, error } = await supabase
    .from("extracted_contacts")
    .upsert(payload, {
      onConflict: "connection_id,message_id",
    })
    .select(
      "id, email, first_name, last_name, phone, title, address, normalized_email, sheet_written, sheet_written_to, message_id"
    )
    .single();

  if (error || !data) {
    throw new Error(
      "Could not save extracted contact: " +
        (error?.message || "No contact row returned.")
    );
  }

  return data;
}

async function ensureContactWrittenToSheet(
  supabase,
  sheets,
  connection,
  contact
) {
  if (contact.sheet_written) {
    return connection.target_sheet_tab_id || null;
  }

  if (!contact.message_id) {
    throw new Error("Cannot safely recover a contact without its message ID.");
  }

  const contactsTab = await ensureContactsTab(
    sheets,
    connection.target_sheet_id,
    connection.target_sheet_tab_id,
    connection.target_sheet_tab_name
  );

  const alreadyWritten = await hasMessageIdInSheet(
    sheets,
    connection.target_sheet_id,
    contactsTab.title,
    contact.message_id
  );

  if (!alreadyWritten) {
    await appendContact(
      sheets,
      connection.target_sheet_id,
      contactsTab.title,
      {
        first_name: contact.first_name,
        last_name: contact.last_name,
        email: contact.email,
        phone: contact.phone,
        title: contact.title,
        address: contact.address,
        source: contact.email || "",
        message_id: contact.message_id,
      }
    );
  }

  const { error } = await supabase
    .from("extracted_contacts")
    .update({
      sheet_written: true,
      sheet_written_to:
        connection.target_sheet_id + ":" + String(contactsTab.tabId),
    })
    .eq("id", contact.id)
    .eq("connection_id", connection.id);

  if (error) {
    throw new Error(
      "The contact was written, but its deduplication state could not be saved: " +
        error.message
    );
  }

  return contactsTab.tabId;
}

async function writeContactToSheet(
  sheets,
  connection,
  contact,
  messageId
) {
  const contactsTab = await ensureContactsTab(
    sheets,
    connection.target_sheet_id,
    connection.target_sheet_tab_id,
    connection.target_sheet_tab_name
  );

  return {
    ...contactsTab,
    ...(await (async () => {
      if (
        contact.sheet_written &&
        contact.sheet_written_to ===
          connection.target_sheet_id + ":" + String(contactsTab.tabId)
      ) {
        return {};
      }

      if (!contact.sheet_written) {
        const alreadyThere = await hasMessageIdInSheet(
          sheets,
          connection.target_sheet_id,
          contactsTab.title,
          messageId
        );

        if (!alreadyThere) {
          await appendContact(
            sheets,
            connection.target_sheet_id,
            contactsTab.title,
            {
              first_name: contact.first_name,
              last_name: contact.last_name,
              email: contact.email,
              phone: contact.phone,
              title: contact.title,
              address: contact.address,
              source: contact.email || "",
              message_id: messageId,
            }
          );
        }
      }

      return {};
    })()),
  };
}

export async function POST(req) {
  let stage = "starting";
  let runId = "";
  let connectionId = "";
  let messageId = "";

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

  const supabase = createSupabase();

  try {
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

    connectionId = run.connection_id;

    stage = "loading Gmail connection";

    const { data: connection, error: connectionError } = await supabase
      .from("google_connections")
      .select(
        "id, google_email, refresh_token, target_sheet_id, target_sheet_tab_id, target_sheet_tab_name"
      )
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

    stage = "finding next Gmail message";

    messageId = await listNextCandidateMessage(
      gmail,
      supabase,
      connection.id
    );

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

    stage = "claiming email";

    const claim = await claimEmail(
      supabase,
      connection.id,
      messageId,
      runId
    );

    if (!claim.claimed) {
      return NextResponse.json({
        done: false,
        skipped: true,
        scanned: 0,
        botsFiltered: 0,
        contactsExtracted: 0,
        activity: "Email is already being processed.",
      });
    }

    await assertRunActive(supabase, runId, user.id);

    stage = "reading Gmail message";

    const message = await loadMessage(gmail, messageId);
    const headers = message.data.payload?.headers || [];

    const fromHeader =
      headers.find(
        (header) => header.name?.toLowerCase() === "from"
      )?.value || "";

    const subject =
      headers.find(
        (header) => header.name?.toLowerCase() === "subject"
      )?.value || "";

    const snippet = message.data.snippet || "";

    if (!fromHeader) {
      throw new Error("The Gmail message does not contain a From address.");
    }

    stage = "checking saved contact state";

    const messageContact = await findContactForMessage(
      supabase,
      connection.id,
      messageId
    );

    if (messageContact?.sheet_written) {
      await setEmailStatus(
        supabase,
        connection.id,
        messageId,
        runId,
        "contact_extracted"
      );

      await incrementRun(supabase, runId, user.id, { scanned: 1, contacts: 1 });

      return NextResponse.json({
        done: false,
        scanned: 1,
        botsFiltered: 0,
        contactsExtracted: 1,
        activity: "Already written to the spreadsheet: " + fromHeader,
      });
    }

    const senderEmail = extractEmailAddress(fromHeader);

    stage = "checking known contacts";

    const knownSenderContact = await findExistingContactByEmail(
      supabase,
      connection.id,
      senderEmail
    );

    if (knownSenderContact) {
      if (!knownSenderContact.sheet_written) {
        stage = "recovering known contact";
        await ensureContactWrittenToSheet(
          supabase,
          sheets,
          connection,
          knownSenderContact
        );
      }

      await setEmailStatus(
        supabase,
        connection.id,
        messageId,
        runId,
        "contact_already_in_sheet"
      );

      await incrementRun(supabase, runId, user.id, { scanned: 1 });

      return NextResponse.json({
        done: false,
        scanned: 1,
        botsFiltered: 0,
        contactsExtracted: 0,
        activity:
          "Contact already known; skipped duplicate: " + fromHeader,
      });
    }

    await assertRunActive(supabase, runId, user.id);

    stage = "classifying sender";

    const human = await classifySender(fromHeader);

    if (!human) {
      await setEmailStatus(
        supabase,
        connection.id,
        messageId,
        runId,
        "bot_filtered"
      );

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

    const extracted = await extractContact(
      fromHeader,
      subject,
      snippet
    );

    const extractedEmail =
      normalizeEmail(extracted.email) || senderEmail;

    const extractedContact = {
      email: extractedEmail,
      first_name: extracted.first_name || null,
      last_name: extracted.last_name || null,
      phone: extracted.phone || null,
      title: extracted.title || null,
      address: extracted.address || null,
    };

    stage = "checking extracted contact";

    const knownExtractedContact = await findExistingContactByEmail(
      supabase,
      connection.id,
      extractedEmail
    );

    if (knownExtractedContact) {
      if (!knownExtractedContact.sheet_written) {
        stage = "recovering extracted contact";
        await ensureContactWrittenToSheet(
          supabase,
          sheets,
          connection,
          knownExtractedContact
        );
      }

      await setEmailStatus(
        supabase,
        connection.id,
        messageId,
        runId,
        "contact_already_in_sheet"
      );

      await incrementRun(supabase, runId, user.id, { scanned: 1 });

      return NextResponse.json({
        done: false,
        scanned: 1,
        botsFiltered: 0,
        contactsExtracted: 0,
        activity:
          "Contact already known; skipped duplicate: " + fromHeader,
      });
    }

    stage = "saving extracted contact";

    const savedContact = await saveExtractedContact(
      supabase,
      connection.id,
      runId,
      messageId,
      extractedContact
    );

    await assertRunActive(supabase, runId, user.id);

    stage = "writing contact to Google Sheet";

    const contactsTab = await ensureContactsTab(
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

    if (!savedContact.sheet_written) {
      const alreadyWritten = await hasMessageIdInSheet(
        sheets,
        connection.target_sheet_id,
        contactsTab.title,
        messageId
      );

      if (!alreadyWritten) {
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
            message_id: messageId,
          }
        );
      }
    }

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
      throw new Error(
        "Could not mark contact as written: " + markError.message
      );
    }

    await setEmailStatus(
      supabase,
      connection.id,
      messageId,
      runId,
      "contact_extracted"
    );

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
      connectionId,
      messageId,
      stage,
      error,
    });

    const message = errorMessage(error);

    if (connectionId && messageId && runId) {
      await supabase
        .rpc("set_email_processing_status", {
          p_connection_id: connectionId,
          p_message_id: messageId,
          p_run_id: runId,
          p_status: "failed",
        })
        .catch(() => undefined);
    }

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

    if (isGoogleAuthError(error)) {
      return NextResponse.json(
        {
          error:
            "Your Google authorization has expired or been revoked. Reconnect Gmail and approve access again.",
          authRequired: true,
        },
        { status: 401 }
      );
    }

    if (isGoogleQuotaError(error)) {
      return NextResponse.json(
        {
          error:
            "Google is temporarily rate-limiting this request. The email was not marked complete; retry in a few seconds.",
          quotaLimited: true,
          stage,
        },
        {
          status: 429,
          headers: {
            "Retry-After": "5",
          },
        }
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
