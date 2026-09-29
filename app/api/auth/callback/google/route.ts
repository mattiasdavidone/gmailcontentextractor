import { NextRequest, NextResponse } from "next/server";
import { google } from "googleapis";
import { createClient } from "@supabase/supabase-js";
import { getCurrentUser } from "@/lib/auth";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const user = await getCurrentUser();

  if (!user) {
    const errorUrl = new URL("/", req.url);
    errorUrl.searchParams.set("google_error", "1");
    return NextResponse.redirect(errorUrl);
  }

  const code = req.nextUrl.searchParams.get("code");

  if (!code) {
    return NextResponse.redirect(new URL("/?connected=1", req.url));
  }

  const redirectUri = new URL(
    "/api/auth/callback/google",
    req.url
  ).toString();

  const oauth2Client = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    redirectUri
  );

  try {
    const { tokens } = await oauth2Client.getToken(code);

    if (!tokens.refresh_token) {
      throw new Error(
        "Google did not return a refresh token. Reconnect Gmail and approve the requested permissions."
      );
    }

    oauth2Client.setCredentials(tokens);

    const oauth2 = google.oauth2({
      version: "v2",
      auth: oauth2Client,
    });

    const userInfo = await oauth2.userinfo.get();
    const googleEmail = userInfo.data.email;

    if (!googleEmail) {
      throw new Error("Google did not return an email address.");
    }

    const supabase = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!
    );

    // Claim a legacy connection created before account support existed.
    await supabase
      .from("google_connections")
      .update({ user_id: user.id })
      .eq("google_email", googleEmail)
      .is("user_id", null);

    const { error } = await supabase
      .from("google_connections")
      .upsert(
        {
          user_id: user.id,
          google_email: googleEmail,
          refresh_token: tokens.refresh_token,
          is_active: true,
        },
        { onConflict: "user_id,google_email" }
      );

    if (error) {
      throw new Error(error.message);
    }

    return NextResponse.redirect(new URL("/", req.url));
  } catch (error) {
    console.error("Google callback failed", error);
    return NextResponse.redirect(new URL("/login", req.url));
  }
}
