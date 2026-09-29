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

  let { data, error } = await supabase
    .from("google_connections")
    .select("id, google_email, target_sheet_id, is_active, user_id")
    .eq("user_id", user.id)
    .eq("is_active", true)
    .order("updated_at", { ascending: false, nullsFirst: false })
    .limit(1)
    .maybeSingle();

  // Backward compatibility: before app accounts existed, the Gmail connection
  // could have been saved without a user_id. Claim it for the signed-in user
  // when the Gmail address matches the account email.
  if (!data && !error) {
    const fallback = await supabase
      .from("google_connections")
      .select("id, google_email, target_sheet_id, is_active, user_id")
      .eq("google_email", user.email)
      .eq("is_active", true)
      .is("user_id", null)
      .limit(1)
      .maybeSingle();

    if (fallback.data) {
      const { data: claimed, error: claimError } = await supabase
        .from("google_connections")
        .update({ user_id: user.id })
        .eq("id", fallback.data.id)
        .select("id, google_email, target_sheet_id, is_active, user_id")
        .single();

      if (!claimError) {
        data = claimed;
      }
    } else if (fallback.error) {
      error = fallback.error;
    }
  }

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
      accountEmail: user.email,
    },
    { headers: { "Cache-Control": "no-store" } }
  );
}
