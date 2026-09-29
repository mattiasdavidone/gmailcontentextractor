import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { google } from "googleapis";

export const maxDuration = 60;
export const dynamic = "force-dynamic";

function getSupabase() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  );
}

function getErrorMessage(error: unknown) {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;

  try {
    return JSON.stringify(error);
  } catch {
    return "Unknown reset error.";
  }
}

export async function POST() {
  try {
    const supabase = getSupabase();

    const { data: connection, error: connectionError } = await supabase
      .from("google_connections")
      .select("id, refresh_token")
      .eq("is_active", true)
      .limit(1)
      .maybeSingle();

    if (connectionError) {
      throw new Error(
        `Supabase connection lookup failed: ${connectionError.message}`
      );
    }

    if (!connection) {
      return NextResponse.json(
        { error: "No active Gmail connection found." },
        { status: 400 }
      );
    }

    const auth = new google.auth.OAuth2(
      process.env.GOOGLE_CLIENT_ID,
      process.env.GOOGLE_CLIENT_SECRET
    );

    auth.setCredentials({ refresh_token: connection.refresh_token });

    const gmail = google.gmail({ version: "v1", auth });

    const labels = await gmail.users.labels.list({ userId: "me" });
    const scanLabel = (labels.data.labels || []).find(
      (label: any) => label.name === "AI-Scanned"
    );

    let scannedMessageIds: string[] = [];

    if (scanLabel?.id) {
      let pageToken: string | undefined;

      do {
        const page = await gmail.users.messages.list({
          userId: "me",
          q: "in:inbox label:AI-Scanned",
          maxResults: 500,
          pageToken,
        });

        scannedMessageIds.push(
          ...(page.data.messages || [])
            .map((message: any) => message.id)
            .filter(Boolean)
        );

        pageToken = page.data.nextPageToken || undefined;
      } while (pageToken);

      for (let i = 0; i < scannedMessageIds.length; i += 1000) {
        const ids = scannedMessageIds.slice(i, i + 1000);

        await gmail.users.messages.batchModify({
          userId: "me",
          requestBody: {
            ids,
            removeLabelIds: [scanLabel.id],
          },
        });
      }
    }

    // The run engine also uses email_logs as a second "already processed"
    // guard. Clear those records so the same inbox emails can genuinely run again.
    const { error: logDeleteError } = await supabase
      .from("email_logs")
      .delete()
      .eq("connection_id", connection.id);

    if (logDeleteError) {
      throw new Error(
        `Could not clear processing history: ${logDeleteError.message}`
      );
    }

    return NextResponse.json({
      success: true,
      emailsReset: scannedMessageIds.length,
      message:
        scannedMessageIds.length > 0
          ? `Cleared scanned status from ${scannedMessageIds.length} inbox emails.`
          : "No AI-Scanned inbox emails were found.",
    });
  } catch (error) {
    console.error("Reset scanned status failed", error);

    return NextResponse.json(
      { error: getErrorMessage(error) },
      { status: 500 }
    );
  }
}
