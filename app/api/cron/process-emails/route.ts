import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

export async function POST() {
  return NextResponse.json(
    {
      status: "DISABLED",
      message:
        "Automated Gmail processing is disabled. Use the dashboard run engine so email processing stays idempotent and cannot race the manual run.",
    },
    { status: 200 }
  );
}
