import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { createGmailClient, getGmailMessagesInBatches } from "@/lib/google-gmail";
import {
  analyzeEmailForContact,
} from "@/lib/contact-ai";
import {
  extractEmailAddress,
  normalizeEmail,
} from "@/lib/google-sheets";
import {
  claimRunJobs,
  createRunDb,
  createWorkerId,
  failRunJobPermanently,
  finishRunJob,
  heartbeatRun,
  requeueStaleJobs,
  acquireRunWorker,
  releaseRunWorker,
} from "@/lib/run-worker";
import { classifyProcessingError } from "@/lib/retry-policy";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const JOB_BATCH_SIZE = 8;

function messageOf(error: unknown) {
  if (error instanceof Error) return error.message;
  return String(error);
}

async function incrementStats(
  supabase: ReturnType<typeof createRunDb>,
  runId: string,
  userId: string,
  delta: { scanned?: number; filtered?: number; contacts?: number }
) {
  const { error } = await supabase.rpc("increment_tool_run_stats", {
    p_run_id: runId,
    p_user_id: userId,
    p_scanned: delta.scanned || 0,
    p_filtered: delta.filtered || 0,
    p_contacts: delta.contacts || 0,
  });

  if (error) {
    console.error("Unable to increment run stats", {
      runId,
      error: error.message,
    });
  }
}

async function enqueueSheetJob(
  supabase: ReturnType<typeof createRunDb>,
  runId: string,
  connectionId: string,
  contactId: string
) {
  const { error } = await supabase.rpc("enqueue_run_sheet_job", {
    p_run_id: runId,
    p_connection_id: connectionId,
    p_contact_id: contactId,
  });

  if (error) {
    throw new Error("Could not queue Google Sheet output: " + error.message);
  }
}

export async function POST(req: Request) {
  const user = await getCurrentUser();

  if (!user) {
    return NextResponse.json({ error: "AUTH_REQUIRED" }, { status: 401 });
  }

  const body = await req.json().catch(() => ({}));
  const runId = typeof body?.runId === "string" ? body.runId : "";

  if (!runId) {
    return NextResponse.json(
      { error: "runId is required." },
      { status: 400 }
    );
  }

  const supabase = createRunDb();
  const workerId = createWorkerId("gmail-worker");
  let leaseAcquired = false;

  try {
    const { data: run, error: runError } = await supabase
      .from("tool_runs")
      .select(
        "id, user_id, connection_id, status, target_email_count, ingestion_complete"
      )
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
      return NextResponse.json({
        ok: true,
        done: true,
        runStatus: run.status,
        processed: 0,
      });
    }

    await acquireRunWorker(supabase, runId, workerId, 90);
    leaseAcquired = true;

    const requeued = await requeueStaleJobs(supabase, runId, 900);
    const jobs = await claimRunJobs(
      supabase,
      runId,
      workerId,
      JOB_BATCH_SIZE
    );

    if (jobs.length === 0) {
      await heartbeatRun(supabase, runId, workerId);

      return NextResponse.json({
        ok: true,
        done: Boolean(run.ingestion_complete),
        processed: 0,
        requeued,
      });
    }

    const { data: connection, error: connectionError } = await supabase
      .from("google_connections")
      .select("id, refresh_token, is_active")
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
      throw new Error("No active Gmail connection found.");
    }

    const { gmail } = createGmailClient(connection.refresh_token);

    let messagesById = new Map<
      string,
      Awaited<ReturnType<typeof getGmailMessagesInBatches>>[number]
    >();

    try {
      const messages = await getGmailMessagesInBatches(
        gmail,
        jobs.map((job) => job.message_id),
        JOB_BATCH_SIZE
      );
      messagesById = new Map(messages.map((message) => [message.id, message]));
    } catch (error) {
      const decision = classifyProcessingError(error);
      const errorText = messageOf(error);

      await Promise.all(
        jobs.map(async (job) => {
          try {
            if (decision.permanent) {
              await failRunJobPermanently(
                supabase,
                job.id,
                workerId,
                errorText
              );
            } else {
              await finishRunJob(
                supabase,
                job.id,
                workerId,
                "failed",
                errorText
              );
            }
          } catch (finishError) {
            console.error("Unable to record Gmail fetch failure", {
              jobId: job.id,
              finishError,
            });
          }
        })
      );

      return NextResponse.json({
        ok: true,
        processed: 0,
        filtered: 0,
        contacts: 0,
        failed: jobs.length,
        retryableFailures: decision.retryable ? jobs.length : 0,
        permanentFailures: decision.permanent ? jobs.length : 0,
        retryReason: decision.reason,
      });
    }

    let processed = 0;
    let filtered = 0;
    let contacts = 0;
    const errors: Array<{ jobId: string; retryable: boolean; reason: string }> = [];

    for (const job of jobs) {
      await heartbeatRun(supabase, runId, workerId).catch(() => undefined);

      try {
        const message = messagesById.get(job.message_id);

        if (!message) {
          const error = new Error("Gmail message could not be loaded.");
          const decision = classifyProcessingError(error);
          await failRunJobPermanently(
            supabase,
            job.id,
            workerId,
            "Gmail message was not returned by the API."
          );
          processed += 1;
          errors.push({
            jobId: job.id,
            retryable: false,
            reason: decision.reason,
          });
          continue;
        }

        const fromHeader = message.from || "";
        const subject = message.subject || "";
        const snippet = message.snippet || "";

        if (!fromHeader) {
          await failRunJobPermanently(
            supabase,
            job.id,
            workerId,
            "The Gmail message does not contain a From address."
          );
          processed += 1;
          errors.push({
            jobId: job.id,
            retryable: false,
            reason: "missing_from",
          });
          continue;
        }

        const analysisHeaders = message.headers || {};

        const extracted = await analyzeEmailForContact({
          from: fromHeader,
          subject,
          snippet,
          headers: analysisHeaders,
        });

        if (!extracted.is_human) {
          filtered += 1;

          await finishRunJob(
            supabase,
            job.id,
            workerId,
            "skipped",
            extracted.reason
          );
          processed += 1;
          continue;
        }

        const senderEmail = extractEmailAddress(fromHeader);
        const extractedEmail =
          normalizeEmail(extracted.email) || senderEmail;

        if (!extractedEmail) {
          await failRunJobPermanently(
            supabase,
            job.id,
            workerId,
            "The contact extractor did not return a usable email address."
          );
          processed += 1;
          errors.push({
            jobId: job.id,
            retryable: false,
            reason: "missing_contact_email",
          });
          continue;
        }

        const { data: contactData, error: contactError } = await supabase.rpc(
          "upsert_extracted_contact",
          {
            p_connection_id: run.connection_id,
            p_message_id: job.message_id,
            p_run_id: runId,
            p_email: extractedEmail,
            p_normalized_email: extractedEmail,
            p_first_name: extracted.first_name,
            p_last_name: extracted.last_name,
            p_phone: extracted.phone,
            p_fax: extracted.fax,
            p_title: extracted.title,
            p_address: extracted.address,
          }
        );

        const contact = Array.isArray(contactData)
          ? contactData[0]
          : contactData;

        if (contactError || !contact) {
          throw new Error(
            "Could not save extracted contact: " +
              (contactError?.message || "No contact row returned.")
          );
        }

        await enqueueSheetJob(
          supabase,
          runId,
          run.connection_id,
          contact.id
        );

        const isNewForMessage = contact.message_id === job.message_id;
        if (isNewForMessage) contacts += 1;

        await finishRunJob(
          supabase,
          job.id,
          workerId,
          "completed",
          isNewForMessage
            ? undefined
            : "Contact already existed for this Gmail connection."
        );
        processed += 1;
      } catch (error) {
        const decision = classifyProcessingError(error);
        const errorText = messageOf(error);

        if (decision.permanent) {
          await failRunJobPermanently(
            supabase,
            job.id,
            workerId,
            errorText
          );
        } else {
          await finishRunJob(
            supabase,
            job.id,
            workerId,
            "failed",
            errorText
          );
        }

        errors.push({
          jobId: job.id,
          retryable: decision.retryable,
          reason: decision.reason,
        });
      }
    }

    await incrementStats(supabase, runId, user.id, {
      scanned: processed,
      filtered,
      contacts,
    });

    await heartbeatRun(supabase, runId, workerId);

    return NextResponse.json({
      ok: true,
      processed,
      filtered,
      contacts,
      failed: errors.length,
      retryableFailures: errors.filter((item) => item.retryable).length,
      permanentFailures: errors.filter((item) => !item.retryable).length,
      requeued,
    });
  } catch (error) {
    const decision = classifyProcessingError(error);

    console.error("Gmail worker failed", {
      runId,
      workerId,
      decision,
      error,
    });

    return NextResponse.json(
      {
        ok: false,
        error: messageOf(error),
        retryable: decision.retryable,
        permanent: decision.permanent,
        reason: decision.reason,
      },
      { status: decision.retryable ? 503 : 500 }
    );
  } finally {
    if (leaseAcquired) {
      await releaseRunWorker(supabase, runId, workerId).catch((error) => {
        console.error("Failed to release Gmail worker lease", error);
      });
    }
  }
}
