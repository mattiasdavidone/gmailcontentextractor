import { google } from "googleapis";

export const CONTACT_HEADERS = [
  "First Name",
  "Last Name",
  "Email",
  "Phone",
  "Fax",
  "Title",
  "Address",
  "Source",
  "Message ID",
];

const LEGACY_CONTACT_HEADERS = CONTACT_HEADERS.slice(0, 8);

type SheetsClient = ReturnType<typeof google.sheets>;

type ContactRow = {
  first_name?: string | null;
  last_name?: string | null;
  email?: string | null;
  phone?: string | null;
  fax?: string | null;
  title?: string | null;
  address?: string | null;
  source?: string | null;
  message_id?: string | null;
};

export function isGoogleQuotaError(error: unknown) {
  const code = Number(
    (error as any)?.code ?? (error as any)?.response?.status ?? 0
  );
  return code === 429 || code === 503;
}

export async function withGoogleRetry<T>(
  operation: () => Promise<T>,
  retries = 3
): Promise<T> {
  let attempt = 0;

  while (true) {
    try {
      return await operation();
    } catch (error) {
      if (attempt >= retries || !isGoogleQuotaError(error)) {
        throw error;
      }

      const delay =
        Math.min(4_000, 400 * 2 ** attempt) +
        Math.floor(Math.random() * 250);

      await new Promise((resolve) => setTimeout(resolve, delay));
      attempt += 1;
    }
  }
}

function escapeSheetTitle(title: string) {
  return title.replace(/'/g, "''");
}

export function contactsHeaderRange(title: string) {
  return "'" + escapeSheetTitle(title) + "'!A1:I1";
}

export function contactsDataRange(title: string) {
  return "'" + escapeSheetTitle(title) + "'!A2:I";
}

export function contactsMessageIdRange(title: string) {
  return "'" + escapeSheetTitle(title) + "'!I2:I";
}

function normalizedHeader(values: unknown[] | undefined) {
  return values?.map((value) => String(value ?? "").trim()) ?? [];
}

function isCurrentHeader(values: unknown[] | undefined) {
  const row = normalizedHeader(values);
  return CONTACT_HEADERS.every((header, index) => row[index] === header);
}

function isLegacyHeader(values: unknown[] | undefined) {
  const row = normalizedHeader(values);
  return LEGACY_CONTACT_HEADERS.every((header, index) => row[index] === header);
}

async function finalizeContactsTab(
  sheets: SheetsClient,
  spreadsheetId: string,
  tabId: number
) {
  await withGoogleRetry(() =>
    sheets.spreadsheets.batchUpdate({
      spreadsheetId,
      requestBody: {
        requests: [
          {
            repeatCell: {
              range: {
                sheetId: tabId,
                startRowIndex: 0,
                endRowIndex: 1,
                startColumnIndex: 0,
                endColumnIndex: CONTACT_HEADERS.length,
              },
              cell: {
                userEnteredFormat: {
                  textFormat: {
                    bold: true,
                  },
                },
              },
              fields: "userEnteredFormat.textFormat.bold",
            },
          },
          {
            updateSheetProperties: {
              properties: {
                sheetId: tabId,
                gridProperties: {
                  frozenRowCount: 1,
                },
              },
              fields: "gridProperties.frozenRowCount",
            },
          },
          ...[
            130, 130, 240, 140, 120, 180, 260, 320, 1
          ].map((pixelSize, index) => ({
            updateDimensionProperties: {
              range: {
                sheetId: tabId,
                dimension: "COLUMNS",
                startIndex: index,
                endIndex: index + 1,
              },
              properties: {
                pixelSize,
                hiddenByUser: index === 8,
              },
              fields: "pixelSize,hiddenByUser",
            },
          })),
        ],
      },
    })
  );
}

async function ensureMessageIdColumn(
  sheets: SheetsClient,
  spreadsheetId: string,
  tabId: number,
  tabName: string,
  headerValues: unknown[] | undefined
) {
  if (isCurrentHeader(headerValues)) return;

  if (isLegacyHeader(headerValues)) {
    await withGoogleRetry(() =>
      sheets.spreadsheets.values.update({
        spreadsheetId,
        range: "'" + escapeSheetTitle(tabName) + "'!I1",
        valueInputOption: "RAW",
        requestBody: {
          values: [[CONTACT_HEADERS[8]]],
        },
      })
    );

    await finalizeContactsTab(sheets, spreadsheetId, tabId);
    return;
  }

  const row = normalizedHeader(headerValues);
  const hasAnyHeader = row.some((value) => value !== "");

  if (!hasAnyHeader) {
    await withGoogleRetry(() =>
      sheets.spreadsheets.values.update({
        spreadsheetId,
        range: contactsHeaderRange(tabName),
        valueInputOption: "RAW",
        requestBody: { values: [CONTACT_HEADERS] },
      })
    );

    await finalizeContactsTab(sheets, spreadsheetId, tabId);
  }
}

export async function ensureContactsTab(
  sheets: SheetsClient,
  spreadsheetId: string,
  targetTabId?: number | null,
  targetTabName?: string | null
) {
  const spreadsheet = await withGoogleRetry(() =>
    sheets.spreadsheets.get({
      spreadsheetId,
      fields:
        "spreadsheetId,spreadsheetUrl,properties(title),sheets.properties(sheetId,title)",
    })
  );

  const tabs = (spreadsheet.data.sheets || [])
    .map((sheet) => sheet.properties)
    .filter(
      (
        properties
      ): properties is {
        sheetId?: number | null;
        title?: string | null;
      } => Boolean(properties)
    );

  const targetById =
    typeof targetTabId === "number"
      ? tabs.find((tab) => tab.sheetId === targetTabId)
      : undefined;

  const targetByName = targetTabName
    ? tabs.find((tab) => tab.title === targetTabName)
    : undefined;

  const namedContacts = tabs.find((tab) => tab.title === "Contacts");

  let target =
    targetById?.sheetId != null && targetById.title
      ? targetById
      : targetByName?.sheetId != null && targetByName.title
        ? targetByName
        : namedContacts?.sheetId != null && namedContacts.title
          ? namedContacts
          : undefined;

  if (!target) {
    const created = await withGoogleRetry(() =>
      sheets.spreadsheets.batchUpdate({
        spreadsheetId,
        requestBody: {
          requests: [
            {
              addSheet: {
                properties: {
                  title: "Contacts",
                  gridProperties: {
                    rowCount: 1000,
                    columnCount: CONTACT_HEADERS.length,
                  },
                },
              },
            },
          ],
        },
      })
    );

    const properties = created.data.replies?.[0]?.addSheet?.properties;

    if (typeof properties?.sheetId !== "number" || !properties.title) {
      throw new Error("Google did not return the new Contacts tab.");
    }

    target = {
      sheetId: properties.sheetId,
      title: properties.title,
    };

    await withGoogleRetry(() =>
      sheets.spreadsheets.values.update({
        spreadsheetId,
        range: contactsHeaderRange(target!.title!),
        valueInputOption: "RAW",
        requestBody: {
          values: [CONTACT_HEADERS],
        },
      })
    );

    await finalizeContactsTab(
      sheets,
      spreadsheetId,
      target.sheetId
    );

    return {
      tabId: target.sheetId,
      title: target.title,
      spreadsheetTitle: spreadsheet.data.properties?.title || "Google Sheet",
      spreadsheetUrl:
        spreadsheet.data.spreadsheetUrl ||
        "https://docs.google.com/spreadsheets/d/" +
          spreadsheetId +
          "/edit",
      created: true,
    };
  }

  const targetSheetId = target.sheetId;
  const targetSheetTitle = target.title;

  if (
    typeof targetSheetId !== "number" ||
    typeof targetSheetTitle !== "string"
  ) {
    throw new Error("Google did not return a valid target Contacts tab.");
  }

  const header = await withGoogleRetry(() =>
    sheets.spreadsheets.values.get({
      spreadsheetId,
      range: "'" + escapeSheetTitle(targetSheetTitle) + "'!A1:I1",
      majorDimension: "ROWS",
    })
  );

  await ensureMessageIdColumn(
    sheets,
    spreadsheetId,
    targetSheetId,
    targetSheetTitle,
    header.data.values?.[0]
  );

  return {
    tabId: targetSheetId,
    title: targetSheetTitle,
    spreadsheetTitle: spreadsheet.data.properties?.title || "Google Sheet",
    spreadsheetUrl:
      spreadsheet.data.spreadsheetUrl ||
      "https://docs.google.com/spreadsheets/d/" +
        spreadsheetId +
        "/edit",
    created: false,
  };
}

export async function readContactsRows(
  sheets: SheetsClient,
  spreadsheetId: string,
  tabName: string
) {
  const response = await withGoogleRetry(() =>
    sheets.spreadsheets.values.get({
      spreadsheetId,
      range: contactsDataRange(tabName),
      majorDimension: "ROWS",
    })
  );

  return response.data.values || [];
}

export async function hasMessageIdInSheet(
  sheets: SheetsClient,
  spreadsheetId: string,
  tabName: string,
  messageId: string
) {
  const response = await withGoogleRetry(() =>
    sheets.spreadsheets.values.get({
      spreadsheetId,
      range: contactsMessageIdRange(tabName),
      majorDimension: "COLUMNS",
    })
  );

  return (response.data.values?.[0] || []).some(
    (value) => String(value || "") === messageId
  );
}

export function normalizeEmail(value: string | null | undefined) {
  return String(value || "").trim().toLowerCase();
}

export function normalizePhone(value: string | null | undefined) {
  return String(value || "").replace(/\D/g, "");
}

export function normalizePersonValue(
  value: string | null | undefined
) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ");
}

export function extractEmailAddress(fromHeader: string) {
  const angleMatch = fromHeader.match(/<([^>]+)>/);
  const raw = angleMatch?.[1] || fromHeader;
  const emailMatch = raw.match(
    /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i
  );
  return emailMatch ? emailMatch[0].trim().toLowerCase() : "";
}

export async function appendContact(
  sheets: SheetsClient,
  spreadsheetId: string,
  tabName: string,
  contact: ContactRow
) {
  const safeTitle = tabName.replace(/'/g, "''");

  await withGoogleRetry(() =>
    sheets.spreadsheets.values.append({
      spreadsheetId,
      range: "'" + safeTitle + "'!A:I",
      valueInputOption: "USER_ENTERED",
      insertDataOption: "INSERT_ROWS",
      requestBody: {
        values: [
          [
            contact.first_name || "",
            contact.last_name || "",
            contact.email || "",
            contact.phone || "",
            contact.fax || "",
            contact.title || "",
            contact.address || "",
            contact.source || "",
            contact.message_id || "",
          ],
        ],
      },
    })
  );
}
