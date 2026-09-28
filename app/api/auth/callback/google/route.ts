import { NextRequest, NextResponse } from "next/server";
import { google } from "googleapis";
import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

export async function GET(req: NextRequest) {
  const searchParams = req.nextUrl.searchParams;
  const code = searchParams.get("code");

  if (!code) {
    return NextResponse.json({ error: "NO CODE PROVIDED" }, { status: 400 });
  }

  const oauth2Client = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    `${process.env.NEXT_PUBLIC_APP_URL || "https://gmailcontentextractor.vercel.app"}/api/auth/callback/google`
  );

  try {
    const { tokens } = await oauth2Client.getToken(code);
    oauth2Client.setCredentials(tokens);

    const oauth2 = google.oauth2({ version: "v2", auth: oauth2Client });
    const userInfo = await oauth2.userinfo.get();
    const userEmail = userInfo.data.email;

    if (!userEmail || !tokens.refresh_token) {
      return NextResponse.json(
        { error: "FAILED TO RETRIEVE REFRESH TOKEN OR EMAIL" },
        { status: 400 }
      );
    }

    const { error } = await supabase.from("google_connections").upsert(
      {
        google_email: userEmail,
        refresh_token: tokens.refresh_token,
        is_active: true,
      },
      { onConflict: "google_email" }
    );

    if (error) throw error;

    return NextResponse.redirect(
      `${process.env.NEXT_PUBLIC_APP_URL || "https://gmailcontentextractor.vercel.app"}/?status=connected`
    );
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
