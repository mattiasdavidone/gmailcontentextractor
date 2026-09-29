import { NextRequest, NextResponse } from "next/server";
import { google } from "googleapis";
import { createClient } from "@supabase/supabase-js";
import { getCurrentUser } from "@/lib/auth";

export const dynamic = "force-dynamic";

function redirectWithError(req: NextRequest, message: string) {
  const url = new URL("/", req.url);
  url.searchParams.set("google_error", "1");
  url.searchParams.set(
    "google_error_message",
    message.slice(0, 500)
  );
  return NextResponse.redirect(url);
}

export async function GET(req: NextRequest) {
  const user = await getCurrentUser();

  if (!user) {
    return NextResponse.redirect(new URL("/login", req.url));
  }

  const code = req.nextUrl.searchParams.get("code");

  if (!code) {
    return redirectWithError(req, "Google did not return an authorization code.");
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
        "Google did not return a refresh token. Use Reconnect and approve the requested Gmail permissions."
      );
    }

    oauth2Client.setCredentials(tokens);

    // Validate the newly issued offline grant immediately. This catches a
    // bad/invalid refresh token during OAuth instead of saving a token that
    // later fails on the first Gmail API request.
    const refreshed = await oauth2Client.refreshAccessToken();
    const refreshedTokens = refreshed.credentials;
    const refreshToken = refreshedTokens.refresh_token || tokens.refresh_token;

    if (!refreshToken) {
      throw new Error("Google did not return a usable refresh token.");
    }

    oauth2Client.setCredentials({
      ...tokens,
      ...refreshedTokens,
      refresh_token: refreshToken,
    });

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

    // First attach a legacy connection created before app accounts existed.
    const { data: legacyConnection, error: legacyLookupError } = await supabase
      .from("google_connections")
      .select("id, user_id")
      .eq("google_email", googleEmail)
      .is("user_id", null)
      .limit(1)
      .maybeSingle();

    if (legacyLookupError) {
      throw new Error(
        "Could not look up the existing Gmail connection: " +
          legacyLookupError.message
      );
    }

    if (legacyConnection) {
      const { data: claimedConnection, error: claimError } = await supabase
        .from("google_connections")
        .update({
          user_id: user.id,
          refresh_token: refreshToken,
          is_active: true,
        })
        .eq("id", legacyConnection.id)
        .select("id, user_id, google_email")
        .single();

      if (claimError || !claimedConnection) {
        throw new Error(
          "Could not attach the Gmail connection to your account: " +
            (claimError?.message || "the updated connection was not returned")
        );
      }
    } else {
      // Avoid depending on a database-side ON CONFLICT definition. This also
      // keeps the reconnect path working if the migration was applied to an
      // older google_connections table without the new composite constraint.
      const { data: existingConnection, error: existingLookupError } =
        await supabase
          .from("google_connections")
          .select("id")
          .eq("user_id", user.id)
          .eq("google_email", googleEmail)
          .limit(1)
          .maybeSingle();

      if (existingLookupError) {
        throw new Error(
          "Could not look up your Gmail connection: " +
            existingLookupError.message
        );
      }

      if (existingConnection) {
        const { data: updatedConnection, error: updateError } = await supabase
          .from("google_connections")
          .update({
            refresh_token: refreshToken,
            is_active: true,
          })
          .eq("id", existingConnection.id)
          .eq("user_id", user.id)
          .select("id, user_id, google_email")
          .single();

        if (updateError || !updatedConnection) {
          throw new Error(
            "Could not update the Gmail connection: " +
              (updateError?.message || "the updated connection was not returned")
          );
        }
      } else {
        const { error: insertError } = await supabase
          .from("google_connections")
          .insert({
            user_id: user.id,
            google_email: googleEmail,
            refresh_token: refreshToken,
            is_active: true,
          });

        if (insertError) {
          throw new Error(
            "Could not save the Gmail connection: " + insertError.message
          );
        }
      }
    }

    // Verify the row exists under the signed-in app account before redirecting.
    const { data: verifiedConnection, error: verifyError } = await supabase
      .from("google_connections")
      .select("id, user_id, google_email, is_active")
      .eq("user_id", user.id)
      .eq("google_email", googleEmail)
      .eq("is_active", true)
      .limit(1)
      .maybeSingle();

    if (verifyError) {
      throw new Error(
        "Gmail was authorized, but the saved connection could not be verified: " +
          verifyError.message
      );
    }

    if (!verifiedConnection) {
      throw new Error(
        "Gmail was authorized, but no active connection was saved for your account."
      );
    }

    const successUrl = new URL("/", req.url);
    successUrl.searchParams.set("connected", "1");
    return NextResponse.redirect(successUrl);
  } catch (error) {
    console.error("Google callback failed", error);

    return redirectWithError(
      req,
      error instanceof Error ? error.message : "Google connection failed."
    );
  }
}
