import { createClient, type SupabaseClient } from "@supabase/supabase-js";

export type RunJob = {
  id: string;
  connection_id: string;
  message_id: string;
  attempts: number;
  max_attempts: number;
};

export function createRunDb() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url || !key) {
    throw new Error("Supabase environment variables are not configured.");
  }

  return createClient(url, key);
}

export function createWorkerId(prefix = "vercel-worker") {
  return `${prefix}-${crypto.randomUUID()}`;
}

export async function acquireRunWorker(
  supabase: SupabaseClient,
  runId: string,
  workerId: string,
  leaseSeconds = 120
) {
  const { data, error } = await supabase.rpc("acquire_run_worker", {
    p_run_id: runId,
    p_worker_id: workerId,
    p_lease_seconds: leaseSeconds,
  });

  if (error) {
    throw new Error("Could not acquire run worker lease: " + error.message);
  }

  if (data !== true) {
    throw new Error("RUN_WORKER_BUSY");
  }
}

export async function releaseRunWorker(
  supabase: SupabaseClient,
  runId: string,
  workerId: string
) {
  const { error } = await supabase.rpc("release_run_worker", {
    p_run_id: runId,
    p_worker_id: workerId,
  });

  if (error) {
    throw new Error("Could not release run worker lease: " + error.message);
  }
}

export async function heartbeatRun(
  supabase: SupabaseClient,
  runId: string,
  workerId: string
) {
  const { data, error } = await supabase.rpc("heartbeat_tool_run", {
    p_run_id: runId,
    p_worker_id: workerId,
  });

  if (error) {
    throw new Error("Could not heartbeat run: " + error.message);
  }

  if (data !== true) {
    throw new Error("RUN_WORKER_LEASE_LOST");
  }
}

export async function requeueStaleJobs(
  supabase: SupabaseClient,
  runId: string,
  staleAfterSeconds = 900
) {
  const { data, error } = await supabase.rpc("requeue_stale_run_email_jobs", {
    p_run_id: runId,
    p_stale_after_seconds: staleAfterSeconds,
  });

  if (error) {
    throw new Error("Could not requeue stale jobs: " + error.message);
  }

  return Number(data || 0);
}

export async function claimRunJobs(
  supabase: SupabaseClient,
  runId: string,
  workerId: string,
  limit = 25
): Promise<RunJob[]> {
  const { data, error } = await supabase.rpc("claim_run_email_jobs", {
    p_run_id: runId,
    p_worker_id: workerId,
    p_limit: limit,
  });

  if (error) {
    throw new Error("Could not claim email jobs: " + error.message);
  }

  return (data || []) as RunJob[];
}

export async function finishRunJob(
  supabase: SupabaseClient,
  jobId: string,
  workerId: string,
  status: "completed" | "skipped" | "failed",
  errorMessage?: string
) {
  const { data, error } = await supabase.rpc("finish_run_email_job", {
    p_job_id: jobId,
    p_worker_id: workerId,
    p_status: status,
    p_error: errorMessage || null,
  });

  if (error) {
    throw new Error("Could not finish email job: " + error.message);
  }

  if (data !== true) {
    throw new Error("RUN_JOB_OWNERSHIP_LOST");
  }
}

export async function markRunIngestionComplete(
  supabase: SupabaseClient,
  runId: string
) {
  const { data, error } = await supabase.rpc("mark_run_ingestion_complete", {
    p_run_id: runId,
  });

  if (error) {
    throw new Error("Could not close Gmail ingestion: " + error.message);
  }

  if (data !== true) {
    throw new Error("RUN_NOT_ACTIVE");
  }
}
