import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

export const dynamic = "force-dynamic";

export async function GET() {
  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  );

  const { data, error } = await supabase
    .from("google_connections")
    .select("google_email, target_sheet_id, is_active")
    .eq("is_active", true)
    .limit(1)
    .maybeSingle();

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json(
    {
      connected: Boolean(data),
      email: data?.google_email ?? null,
      sheetId: data?.target_sheet_id ?? null,
    },
    { headers: { "Cache-Control": "no-store" } }
  );
}
