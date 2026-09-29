import { NextResponse } from "next/server";
import { createRunDb } from "@/lib/run-worker";
import { isCronRequest } from "@/lib/cron-auth";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const WORKER_PASSES_PER_TICK = 4;

async function callWorker(
  origin: string,
  path: string,
  runId: string,
  secret: string
) {
  const response = await fetch(origin + path, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${secret}`,
    },
    body: JSON.stringify({ runId }),
    cache: "no-store",
  });

  const data = await response.json().catch(() => ({}));
  return { status: response.status, data };
}

export async function GET(req: Request) {
  if (!isCronRequest(req)) {
    return NextResponse.json({ error: "UNAUTHORIZED" }, { status: 401 });
  }

  const secret = process.env.CRON_SECRET;
  if (!secret) {
    return NextResponse.json(
      { error: "CRON_SECRET is not configured." },
      { status: 503 }
    );
  }

  const supabase = createRunDb();
  const { data: run, error } = await supabase
    .from("tool_runs")
    .select("id, status, ingestion_complete")
    .eq("status", "running")
    .order("started_at", { ascending: true })
    .limit(1)
    .maybeSingle();

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  if (!run) {
    return NextResponse.json({ ok: true, activeRuns: 0 });
  }

  const origin = new URL(req.url).origin;
  const results: Array<{ step: string; status: number; data: unknown }> = [];

  if (!run.ingestion_complete) {
    const result = await callWorker(
      origin,
      "/api/run/ingest",
      run.id,
      secret
    );
    results.push({ step: "ingest", ...result });
  }

  for (let pass = 0; pass < WORKER_PASSES_PER_TICK; pass += 1) {
    const result = await callWorker(
      origin,
      "/api/run/worker",
      run.id,
      secret
    );
    results.push({ step: `gmail-${pass + 1}`, ...result });

    if (
      result.data &&
      typeof result.data === "object" &&
      "processed" in result.data &&
      Number((result.data as { processed?: number }).processed || 0) === 0
    ) {
      break;
    }
  }

  const sheetResult = await callWorker(
    origin,
    "/api/run/sheets",
    run.id,
    secret
  );
  results.push({ step: "sheets", ...sheetResult });

  return NextResponse.json({
    ok: true,
    runId: run.id,
    results,
  });
}
