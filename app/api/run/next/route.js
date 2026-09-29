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

function getGoogleStatus(error) {
  return Number(
    error?.code ??
      error?.response?.status ??
      error?.status ??
      error?.response?.data?.error?.code ??
      0
  );
}

function isGoogleQuotaError(error) {
  const status = getGoogleStatus(error);
  return status === 429 || status === 503;
}

function isGoogleAuthError(error) {
  const status = getGoogleStatus(error);
  const message = errorMessage(error).toLowerCase();

  return (
    status === 401 ||
    message.includes("invalid_grant") ||
    message.includes("invalid grant") ||
    message.includes("token has been expired") ||
    message.includes("token has been revoked") ||
    message.includes("insufficient permission")
  );
}

function isMissingSheetError(error) {
  const status = getGoogleStatus(error);
  const message = errorMessage(error).toLowerCase();

  return (
    status === 404 ||
    (status === 400 &&
      (message.includes("unable to parse range") ||
        message.includes("range not found") ||
        message.includes("not found")))
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
      "Could not update run totals: " +
        (error?.message || "run was not found.")
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

    if (ids.length === 0) return null;

    const { data: logs, error } = await supabase
      .from("email_logs")
      .select("message_id, status, processed_at")
      .eq("connection_id", connectionId)
      .in("message_id", ids);

    if (error) {
      throw new Error(
        "Could not load email processing history: " + error.message
      );
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

      if (!log) return id;

      if (log.status === "reset" || log.status === "failed") return id;

      if (
        log.status === "processing" &&
        log.processedAt > 0 &&
        now - log.processedAt > 10 * 60 * 1000
      ) {
        return id;
      }
    }

    pageToken = response.data.nextPageToken || undefined;

    if (!pageToken) return null;
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

async function findContactForMessage(supabase, connectionId, messageId) {
  const { data, error } = await supabase
    .from("extracted_contacts")
    .select(
      "id, email, first_name, last_name, phone, fax, title, address, normalized_email, sheet_written, sheet_written_to, message_id"
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

async function findExistingContactByEmail(supabase, connectionId, email) {
  const normalized = normalizeEmail(email);

  if (!normalized) return null;

  const { data, error } = await supabase
    .from("extracted_contacts")
    .select(
      "id, email, first_name, last_name, phone, fax, title, address, normalized_email, sheet_written, sheet_written_to, message_id"
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

async function saveExtractedContact(
  supabase,
  connectionId,
  runId,
  messageId,
  contact
) {
  const email = normalizeEmail(contact.email || "");

  const { data, error } = await supabase.rpc("upsert_extracted_contact", {
    p_connection_id: connectionId,
    p_message_id: messageId,
    p_run_id: runId,
    p_email: email,
    p_normalized_email: email || null,
    p_first_name: contact.first_name || null,
    p_last_name: contact.last_name || null,
    p_phone: contact.phone || null,
    p_fax: contact.fax || null,
    p_title: contact.title || null,
    p_address: contact.address || null,
  });

  const row = Array.isArray(data) ? data[0] : data;

  if (error || !row) {
    throw new Error(
      "Could not save extracted contact: " +
        (error?.message || "No contact row returned.")
    );
  }

  return row;
}

function sheetLocation(sheetId, tabId) {
  return sheetId + ":" + String(tabId);
}

function isContactWrittenToCurrentSheet(contact, connection) {
  return (
    contact.sheet_written === true &&
    typeof contact.sheet_written_to === "string" &&
    typeof connection.target_sheet_id === "string" &&
    typeof connection.target_sheet_tab_id === "number" &&
    contact.sheet_written_to ===
      sheetLocation(
        connection.target_sheet_id,
        connection.target_sheet_tab_id
      )
  );
}

function isPendingSheetWrite(contact) {
  return (
    !contact.sheet_written &&
    typeof contact.sheet_written_to === "string" &&
    contact.sheet_written_to.startsWith("pending:")
  );
}

function pendingSheetLocation(sheetId, tabId) {
  return "pending:" + sheetLocation(sheetId, tabId);
}

async function saveConnectionTab(
  supabase,
  connectionId,
  userId,
  tab
) {
  const { error } = await supabase
    .from("google_connections")
    .update({
      target_sheet_tab_id: tab.tabId,
      target_sheet_tab_name: tab.title,
    })
    .eq("id", connectionId)
    .eq("user_id", userId);

  if (error) {
    throw new Error("Could not save the Contacts tab: " + error.message);
  }
}

async function resolveContactsTab(
  supabase,
  sheets,
  connection,
  userId
) {
  if (
    typeof connection.target_sheet_tab_id === "number" &&
    typeof connection.target_sheet_tab_name === "string" &&
    connection.target_sheet_tab_name.trim()
  ) {
    return {
      tabId: connection.target_sheet_tab_id,
      title: connection.target_sheet_tab_name,
      created: false,
    };
  }

  const tab = await ensureContactsTab(
    sheets,
    connection.target_sheet_id,
    connection.target_sheet_tab_id,
    connection.target_sheet_tab_name
  );

  await saveConnectionTab(supabase, connection.id, userId, tab);

  return tab;
}

async function markContactWritten(
  supabase,
  contactId,
  connectionId,
  target
) {
  const { error } = await supabase
    .from("extracted_contacts")
    .update({
      sheet_written: true,
      sheet_written_to: sheetLocation(
        target.spreadsheetId,
        target.tabId
      ),
    })
    .eq("id", contactId)
    .eq("connection_id", connectionId);

  if (error) {
    throw new Error(
      "Could not mark contact as written: " + error.message
    );
  }
}

async function writeContactToSheet(
  supabase,
  sheets,
  connection,
  user,
  contact,
  source
) {
  if (isContactWrittenToCurrentSheet(contact, connection)) return;

  const needsRecoveryCheck = isPendingSheetWrite(contact);
  let contactsTab;

  if (needsRecoveryCheck) {
    contactsTab = await resolveContactsTab(
      supabase,
      sheets,
      connection,
      user.id
    );

    let alreadyWritten = false;

    try {
      alreadyWritten = await hasMessageIdInSheet(
        sheets,
        connection.target_sheet_id,
        contactsTab.title,
        contact.message_id
      );
    } catch (error) {
      if (!isMissingSheetError(error)) {
        throw error;
      }

      contactsTab = await ensureContactsTab(
        sheets,
        connection.target_sheet_id,
        connection.target_sheet_tab_id,
        connection.target_sheet_tab_name
      );

      await saveConnectionTab(
        supabase,
        connection.id,
        user.id,
        contactsTab
      );
    }

    if (alreadyWritten) {
      await markContactWritten(
        supabase,
        contact.id,
        connection.id,
        {
          spreadsheetId: connection.target_sheet_id,
          tabId: contactsTab.tabId,
        }
      );

      return;
    }
  } else if (
    typeof connection.target_sheet_tab_id === "number" &&
    typeof connection.target_sheet_tab_name === "string" &&
    connection.target_sheet_tab_name.trim()
  ) {
    contactsTab = {
      tabId: connection.target_sheet_tab_id,
      title: connection.target_sheet_tab_name,
    };
  } else {
    contactsTab = await resolveContactsTab(
      supabase,
      sheets,
      connection,
      user.id
    );
  }

  const pendingLocation = pendingSheetLocation(
    connection.target_sheet_id,
    contactsTab.tabId
  );

  const { error: pendingError } = await supabase
    .from("extracted_contacts")
    .update({
      sheet_written: false,
      sheet_written_to: pendingLocation,
    })
    .eq("id", contact.id)
    .eq("connection_id", connection.id);

  if (pendingError) {
    throw new Error(
      "Could not reserve the contact for spreadsheet writing: " +
        pendingError.message
    );
  }

  const appendPayload = {
    first_name: contact.first_name,
    last_name: contact.last_name,
    email: contact.email,
    phone: contact.phone,
    fax: contact.fax,
    title: contact.title,
    address: contact.address,
    source,
    message_id: contact.message_id,
  };

  try {
    await appendContact(
      sheets,
      connection.target_sheet_id,
      contactsTab.title,
      appendPayload
    );
  } catch (error) {
    if (!isMissingSheetError(error)) {
      throw error;
    }

    const repairedTab = await ensureContactsTab(
      sheets,
      connection.target_sheet_id,
      connection.target_sheet_tab_id,
      connection.target_sheet_tab_name
    );

    await saveConnectionTab(
      supabase,
      connection.id,
      user.id,
      repairedTab
    );

    await supabase
      .from("extracted_contacts")
      .update({
        sheet_written: false,
        sheet_written_to: pendingSheetLocation(
          connection.target_sheet_id,
          repairedTab.tabId
        ),
      })
      .eq("id", contact.id)
      .eq("connection_id", connection.id);

    await appendContact(
      sheets,
      connection.target_sheet_id,
      repairedTab.title,
      appendPayload
    );

    contactsTab = repairedTab;
  }

  await markContactWritten(
    supabase,
    contact.id,
    connection.id,
    {
      spreadsheetId: connection.target_sheet_id,
      tabId: contactsTab.tabId,
    }
  );
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

    const clientId = process.env.GOOGLE_CLIENT_ID;
    const clientSecret = process.env.GOOGLE_CLIENT_SECRET;

    if (!clientId || !clientSecret) {
      throw new Error("Google OAuth environment variables are not configured.");
    }

    const auth = new google.auth.OAuth2(clientId, clientSecret);
    auth.setCredentials({ refresh_token: connection.refresh_token });

    const gmail = google.gmail({ version: "v1", auth });

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
        activity:
          claim.status === "processing"
            ? "Email is already being processed."
            : "Email was already completed.",
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

    if (messageContact) {
      if (!isContactWrittenToCurrentSheet(messageContact, connection)) {
        stage = "recovering saved contact";

        const sheets = google.sheets({ version: "v4", auth, retry: false });

        await writeContactToSheet(
          supabase,
          sheets,
          connection,
          user,
          messageContact,
          fromHeader
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
        activity: "Recovered contact: " + fromHeader,
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

    const senderEmail = extractEmailAddress(fromHeader);
    const extractedEmail =
      normalizeEmail(extracted.email) || senderEmail;

    if (!extractedEmail) {
      throw new Error(
        "The contact extractor did not return a usable email address."
      );
    }

    const extractedContact = {
      email: extractedEmail,
      first_name: extracted.first_name || null,
      last_name: extracted.last_name || null,
      phone: extracted.phone || null,
      fax: extracted.fax || null,
      title: extracted.title || null,
      address: extracted.address || null,
    };

    stage = "checking known contacts";

    const knownContact = await findExistingContactByEmail(
      supabase,
      connection.id,
      extractedEmail
    );

    if (knownContact) {
      stage = "recovering known contact";

      if (!isContactWrittenToCurrentSheet(knownContact, connection)) {
        const sheets = google.sheets({ version: "v4", auth, retry: false });

        await writeContactToSheet(
          supabase,
          sheets,
          connection,
          user,
          knownContact,
          fromHeader
        );
      }

      await setEmailStatus(
        supabase,
        connection.id,
        messageId,
        runId,
        "contact_already_in_sheet"
      );

      await incrementRun(supabase, runId, user.id, {
        scanned: 1,
      });

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

    // The atomic DB upsert can return a canonical contact created by another
    // worker between our earlier duplicate check and this write. Treat that
    // case as a duplicate instead of counting it as a new contact.
    if (savedContact.message_id !== messageId) {
      if (!isContactWrittenToCurrentSheet(savedContact, connection)) {
        const sheets = google.sheets({ version: "v4", auth, retry: false });

        await writeContactToSheet(
          supabase,
          sheets,
          connection,
          user,
          savedContact,
          fromHeader
        );
      }

      await setEmailStatus(
        supabase,
        connection.id,
        messageId,
        runId,
        "contact_already_in_sheet"
      );

      await incrementRun(supabase, runId, user.id, {
        scanned: 1,
      });

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

    stage = "writing contact to Google Sheet";

    const sheets = google.sheets({ version: "v4", auth, retry: false });

    await writeContactToSheet(
      supabase,
      sheets,
      connection,
      user,
      savedContact,
      fromHeader
    );

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
      await setEmailStatus(
        supabase,
        connectionId,
        messageId,
        runId,
        "failed"
      ).catch(() => undefined);
    }

    if (isGoogleQuotaError(error)) {
      return NextResponse.json(
        {
          error:
            "Google is temporarily rate-limiting this request. Retrying the same email shortly.",
          quotaLimited: true,
          retryable: true,
          retryAfterSeconds: 5,
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
            "Your Google authorization has expired or is missing the required Gmail read permission. Reconnect Gmail and approve access again.",
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
