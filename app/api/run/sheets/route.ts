import { NextResponse } from "next/server";
import { google } from "googleapis";
import { getCurrentUser } from "@/lib/auth";
import { isCronRequest } from "@/lib/cron-auth";
import {
  appendContacts,
  ensureContactsTab,
  readSheetMessageIds,
  type ContactSheetRow,
} from "@/lib/google-sheets";
import {
  acquireSheetWorker,
  claimSheetJobs,
  createRunDb,
  createWorkerId,
  finishSheetJob,
  releaseSheetWorker,
  requeueStaleSheetJobs,
} from "@/lib/run-worker";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const JOB_BATCH_SIZE = 25;
const MIN_WRITE_INTERVAL_MS = 1100;

function errorMessage(error: unknown) {
  if (error instanceof Error) return error.message;
  return String(error);
}

function statusCode(error: unknown) {
  return Number(
    (error as any)?.code ??
      (error as any)?.response?.status ??
      (error as any)?.status ??
      0
  );
}

function isRetryableSheetsError(error: unknown) {
  const status = statusCode(error);
  return status === 429 || status === 503 || status === 500;
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function sheetLocation(spreadsheetId: string, tabId: number) {
  return spreadsheetId + ":" + String(tabId);
}

export async function POST(req: Request) {
  const cron = isCronRequest(req);
  const user = cron ? null : await getCurrentUser();
  if (!cron && !user) {
    return NextResponse.json({ error: "AUTH_REQUIRED" }, { status: 401 });
  }

  const body = await req.json().catch(() => ({}));
  const runId = typeof body?.runId === "string" ? body.runId : "";
  if (!runId) {
    return NextResponse.json({ error: "runId is required." }, { status: 400 });
  }

  const supabase = createRunDb();
  const workerId = createWorkerId("sheet-writer");
  let leaseAcquired = false;

  try {
    const { data: run, error: runError } = await supabase
      .from("tool_runs")
      .select(
        "id, connection_id, status, sheet_queued_count, sheet_completed_count, sheet_failed_count"
      )
      .eq("id", runId)
      .maybeSingle();

    if (runError) {
      throw new Error("Could not load run: " + runError.message);
    }
    if (!run) {
      return NextResponse.json({ error: "Run not found." }, { status: 404 });
    }
    if (run.status !== "running") {
      return NextResponse.json({
        ok: true,
        done: true,
        runStatus: run.status,
        processed: 0,
      });
    }

    await acquireSheetWorker(supabase, runId, workerId, 120);
    leaseAcquired = true;

    await requeueStaleSheetJobs(supabase, runId, 900);
    const jobs = await claimSheetJobs(
      supabase,
      runId,
      workerId,
      JOB_BATCH_SIZE
    );

    if (jobs.length === 0) {
      return NextResponse.json({
        ok: true,
        done: true,
        processed: 0,
        remaining: Math.max(
          0,
          Number(run.sheet_queued_count || 0) -
            Number(run.sheet_completed_count || 0) -
            Number(run.sheet_failed_count || 0)
        ),
      });
    }

    const { data: connection, error: connectionError } = await supabase
      .from("google_connections")
      .select(
        "id, google_email, refresh_token, target_sheet_id, target_sheet_tab_id, target_sheet_tab_name"
      )
      .eq("id", run.connection_id)
      .eq("is_active", true)
      .maybeSingle();

    if (connectionError) {
      throw new Error(
        "Could not load Google Sheet connection: " + connectionError.message
      );
    }
    if (!connection?.target_sheet_id) {
      throw new Error("No target Google Sheet is configured.");
    }

    if (!process.env.GOOGLE_CLIENT_ID || !process.env.GOOGLE_CLIENT_SECRET) {
      throw new Error("Google OAuth environment variables are not configured.");
    }

    const auth = new google.auth.OAuth2(
      process.env.GOOGLE_CLIENT_ID,
      process.env.GOOGLE_CLIENT_SECRET
    );
    auth.setCredentials({ refresh_token: connection.refresh_token });

    const sheets = google.sheets({ version: "v4", auth, retry: false });

    const tab = await ensureContactsTab(
      sheets,
      connection.target_sheet_id,
      connection.target_sheet_tab_id,
      connection.target_sheet_tab_name
    );

    if (
      connection.target_sheet_tab_id !== tab.tabId ||
      connection.target_sheet_tab_name !== tab.title
    ) {
      let updateQuery = supabase
        .from("google_connections")
        .update({
          target_sheet_tab_id: tab.tabId,
          target_sheet_tab_name: tab.title,
        })
        .eq("id", connection.id);

      if (user) {
        updateQuery = updateQuery.eq("user_id", user.id);
      }

      const { error: tabUpdateError } = await updateQuery;

      if (tabUpdateError) {
        throw new Error(
          "Could not save the Contacts tab: " + tabUpdateError.message
        );
      }
    }

    const messageIdsAlreadyInSheet = await readSheetMessageIds(
      sheets,
      connection.target_sheet_id,
      tab.title
    );

    const contactIds = jobs.map((job) => job.contact_id);
    const { data: contacts, error: contactsError } = await supabase
      .from("extracted_contacts")
      .select(
        "id, first_name, last_name, email, phone, fax, title, address, message_id"
      )
      .eq("connection_id", connection.id)
      .in("id", contactIds);

    if (contactsError) {
      throw new Error(
        "Could not load contacts for Sheets: " + contactsError.message
      );
    }

    const contactsById = new Map(
      (contacts || []).map((contact) => [contact.id, contact])
    );

    const pendingRows: Array<{
      jobId: string;
      contactId: string;
      row: ContactSheetRow;
    }> = [];

    for (const job of jobs) {
      const contact = contactsById.get(job.contact_id);

      if (!contact || !contact.message_id) {
        await finishSheetJob(
          supabase,
          job.id,
          workerId,
          "skipped",
          "Contact row no longer exists."
        );
        continue;
      }

      if (messageIdsAlreadyInSheet.has(contact.message_id)) {
        await supabase
          .from("extracted_contacts")
          .update({
            sheet_written: true,
            sheet_written_to: sheetLocation(
              connection.target_sheet_id,
              tab.tabId
            ),
          })
          .eq("id", contact.id)
          .eq("connection_id", connection.id);

        await finishSheetJob(supabase, job.id, workerId, "skipped");
        continue;
      }

      pendingRows.push({
        jobId: job.id,
        contactId: contact.id,
        row: {
          first_name: contact.first_name,
          last_name: contact.last_name,
          email: contact.email,
          phone: contact.phone,
          fax: contact.fax,
          title: contact.title,
          address: contact.address,
          source: connection.google_email || "",
          message_id: contact.message_id,
        },
      });
    }

    let processed = jobs.length - pendingRows.length;

    for (let offset = 0; offset < pendingRows.length; offset += JOB_BATCH_SIZE) {
      const batch = pendingRows.slice(offset, offset + JOB_BATCH_SIZE);

      if (offset > 0) {
        await sleep(MIN_WRITE_INTERVAL_MS);
      }

      try {
        await appendContacts(
          sheets,
          connection.target_sheet_id,
          tab.title,
          batch.map((item) => item.row)
        );
      } catch (error) {
        const message = errorMessage(error);

        await Promise.all(
          batch.map((item) =>
            finishSheetJob(
              supabase,
              item.jobId,
              workerId,
              "failed",
              isRetryableSheetsError(error)
                ? "Google Sheets temporarily rejected the batch: " + message
                : message
            ).catch((finishError) => {
              console.error("Failed to record Sheets job failure", finishError);
            })
          )
        );

        if (isRetryableSheetsError(error)) {
          return NextResponse.json(
            {
              ok: false,
              retryable: true,
              processed,
              error: "Google Sheets temporarily rejected the batch.",
            },
            {
              status: 429,
              headers: { "Retry-After": "10" },
            }
          );
        }

        throw error;
      }

      await Promise.all(
        batch.map(async (item) => {
          const updateResult = await supabase
            .from("extracted_contacts")
            .update({
              sheet_written: true,
              sheet_written_to: sheetLocation(
                connection.target_sheet_id,
                tab.tabId
              ),
            })
            .eq("id", item.contactId)
            .eq("connection_id", connection.id);

          if (updateResult.error) {
            throw new Error(
              "Could not mark contact as written: " + updateResult.error.message
            );
          }

          await finishSheetJob(supabase, item.jobId, workerId, "completed");
        })
      );

      processed += batch.length;
    }

    return NextResponse.json({
      ok: true,
      processed,
      claimed: jobs.length,
      remaining: Math.max(
        0,
        Number(run.sheet_queued_count || 0) -
          Number(run.sheet_completed_count || 0) -
          Number(run.sheet_failed_count || 0) -
          processed
      ),
    });
  } catch (error) {
    if (error instanceof Error && error.message === "SHEET_WORKER_BUSY") {
      return NextResponse.json({
        ok: true,
        busy: true,
        processed: 0,
      });
    }

    console.error("Sheets worker failed", {
      runId,
      workerId,
      error,
    });

    return NextResponse.json(
      {
        error:
          error instanceof Error ? error.message : "Sheets worker failed.",
      },
      { status: 500 }
    );
  } finally {
    if (leaseAcquired) {
      await releaseSheetWorker(supabase, runId, workerId).catch((error) => {
        console.error("Failed to release Sheets worker lease", error);
      });
    }
  }
}
