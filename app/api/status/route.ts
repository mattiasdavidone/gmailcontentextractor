import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { getCurrentUser } from "@/lib/auth";

export const dynamic = "force-dynamic";

export async function GET() {
  const user = await getCurrentUser();

  if (!user) {
    return NextResponse.json({ error: "AUTH_REQUIRED" }, { status: 401 });
  }

  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  );

  const { data, error } = await supabase
    .from("google_connections")
    .select(
      "id, google_email, target_sheet_id, target_sheet_tab_name, is_active, user_id"
    )
    .eq("user_id", user.id)
    .eq("is_active", true)
    .limit(1)
    .maybeSingle();

  if (error) {
    return NextResponse.json(
      { error: error.message, connected: false, accountEmail: user.email },
      { status: 500 }
    );
  }

  return NextResponse.json(
    {
      connected: Boolean(data),
      email: data?.google_email ?? null,
      sheetId: data?.target_sheet_id ?? null,
      sheetTabName: data?.target_sheet_tab_name ?? null,
      accountEmail: user.email,
    },
    { headers: { "Cache-Control": "no-store" } }
  );
}
