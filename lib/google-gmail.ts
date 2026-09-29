import { google } from "googleapis";

export const GMAIL_LIST_PAGE_SIZE = 500;
export const GMAIL_PROCESS_BATCH_SIZE = 25;

export type GmailMessageSummary = {
  id: string;
  threadId?: string;
};

export type GmailMessage = {
  id: string;
  threadId?: string;
  snippet?: string;
  payload?: {
    headers?: Array<{ name?: string | null; value?: string | null }> | null;
  } | null;
};

export function createGmailClient(
  refreshToken: string,
  clientId = process.env.GOOGLE_CLIENT_ID,
  clientSecret = process.env.GOOGLE_CLIENT_SECRET
) {
  if (!clientId || !clientSecret) {
    throw new Error("Google OAuth environment variables are not configured.");
  }

  if (!refreshToken) {
    throw new Error("Google refresh token is missing.");
  }

  const auth = new google.auth.OAuth2(clientId, clientSecret);
  auth.setCredentials({ refresh_token: refreshToken });

  return {
    auth,
    gmail: google.gmail({ version: "v1", auth }),
  };
}

export async function listGmailMessageIds(
  gmail: ReturnType<typeof google.gmail>,
  query: string,
  pageToken?: string
) {
  const response = await gmail.users.messages.list({
    userId: "me",
    q: query,
    maxResults: GMAIL_LIST_PAGE_SIZE,
    pageToken,
  });

  return {
    messageIds: (response.data.messages || [])
      .map((message) => message.id)
      .filter((id): id is string => Boolean(id)),
    nextPageToken: response.data.nextPageToken || null,
    resultSizeEstimate: Number(response.data.resultSizeEstimate || 0),
  };
}

function getHeader(message: GmailMessage, name: string) {
  return (
    message.payload?.headers?.find(
      (header) => header.name?.toLowerCase() === name.toLowerCase()
    )?.value || ""
  );
}

export function normalizeGmailMessage(message: GmailMessage) {
  return {
    id: message.id,
    threadId: message.threadId || "",
    snippet: message.snippet || "",
    from: getHeader(message, "From"),
    subject: getHeader(message, "Subject"),
  };
}

/**
 * Gmail supports HTTP batch requests, but Google's guidance recommends
 * no more than 50 inner requests. The googleapis Node client does not expose
 * a stable typed helper for multipart Gmail batching, so the worker uses
 * bounded parallel get calls instead. This keeps concurrency below Gmail's
 * per-user pressure point and is easy to retry per-message.
 */
export async function getGmailMessagesInBatches(
  gmail: ReturnType<typeof google.gmail>,
  messageIds: string[],
  batchSize = GMAIL_PROCESS_BATCH_SIZE
) {
  const messages: GmailMessage[] = [];

  for (let offset = 0; offset < messageIds.length; offset += batchSize) {
    const batchIds = messageIds.slice(offset, offset + batchSize);
    const results = await Promise.all(
      batchIds.map(async (id) => {
        const response = await gmail.users.messages.get({
          userId: "me",
          id,
          format: "metadata",
          metadataHeaders: ["From", "Subject"],
        });

        return response.data as GmailMessage;
      })
    );

    messages.push(...results);
  }

  return messages.map(normalizeGmailMessage);
}
