import { NextRequest, NextResponse } from "next/server";
import { google } from "googleapis";
import { createClient } from "@supabase/supabase-js";

export async function GET(req: NextRequest) {
  const redirectUri = new URL(
    "/api/auth/callback/google",
    req.url
  ).toString();

  const force = req.nextUrl.searchParams.get("force") === "1";

  if (force) {
    const supabase = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!
    );

    const { data: connection } = await supabase
      .from("google_connections")
      .select("refresh_token")
      .eq("is_active", true)
      .limit(1)
      .maybeSingle();

    if (connection?.refresh_token) {
      const revokeClient = new google.auth.OAuth2(
        process.env.GOOGLE_CLIENT_ID,
        process.env.GOOGLE_CLIENT_SECRET,
        redirectUri
      );

      try {
        await revokeClient.revokeToken(connection.refresh_token);
      } catch {
        // The token may already be revoked or expired. Continue with
        // a fresh consent request below.
      }
    }
  }

  const oauth2Client = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    redirectUri
  );

  const url = oauth2Client.generateAuthUrl({
    access_type: "offline",
    prompt: "consent",
    scope: [
      "https://www.googleapis.com/auth/gmail.modify",
      "https://www.googleapis.com/auth/spreadsheets",
      "https://www.googleapis.com/auth/userinfo.email",
    ],
  });

  return NextResponse.redirect(url);
}
