import { NextRequest, NextResponse } from "next/server";
import { createSession, verifyPassword } from "@/lib/auth";
import { createClient } from "@supabase/supabase-js";

function getSupabase() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  );
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const email = String(body.email || "").trim().toLowerCase();
    const password = String(body.password || "");

    const supabase = getSupabase();

    const { data: user, error } = await supabase
      .from("app_users")
      .select("id, email, password_hash")
      .eq("email", email)
      .maybeSingle();

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    if (!user || !verifyPassword(password, user.password_hash)) {
      return NextResponse.json(
        { error: "Email or password is incorrect." },
        { status: 401 }
      );
    }

    await createSession(user.id);

    return NextResponse.json({ success: true });
  } catch {
    return NextResponse.json(
      { error: "Unable to sign in." },
      { status: 500 }
    );
  }
}
