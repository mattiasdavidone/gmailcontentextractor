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
] as const;

type SheetsClient = ReturnType<typeof google.sheets>;

function escapeSheetTitle(title: string) {
  return title.replace(/'/g, "''");
}

export function contactsHeaderRange(title: string) {
  return `'${escapeSheetTitle(title)}'!A1:H1`;
}

export function contactsDataRange(title: string) {
  return `'${escapeSheetTitle(title)}'!A2:H`;
}

export async function createContactsTab(
  sheets: SheetsClient,
  spreadsheetId: string
) {
  const spreadsheet = await sheets.spreadsheets.get({
    spreadsheetId,
    fields: "sheets.properties(sheetId,title)",
  });

  const existingTitles = new Set(
    (spreadsheet.data.sheets || [])
      .map((sheet) => sheet.properties?.title)
      .filter((title): title is string => Boolean(title))
  );

  let title = "Contacts";
  let suffix = 2;

  while (existingTitles.has(title)) {
    title = `Contacts ${suffix}`;
    suffix += 1;
  }

  const batch = await sheets.spreadsheets.batchUpdate({
    spreadsheetId,
    requestBody: {
      requests: [
        {
          addSheet: {
            properties: {
              title,
              gridProperties: {
                rowCount: 1000,
                columnCount: CONTACT_HEADERS.length,
              },
            },
          },
        },
      ],
    },
  });

  const tabId = batch.data.replies?.[0]?.addSheet?.properties?.sheetId;

  if (typeof tabId !== "number") {
    throw new Error("Google did not return the new Contacts tab ID.");
  }

  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range: contactsHeaderRange(title),
    valueInputOption: "RAW",
    requestBody: {
      values: [CONTACT_HEADERS],
    },
  });

  await sheets.spreadsheets.batchUpdate({
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
          130, 130, 240, 140, 120, 180, 260, 320
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
            },
            fields: "pixelSize",
          },
        })),
      ],
    },
  });

  return { tabId, title };
}

export async function getTargetContactsTab(
  sheets: SheetsClient,
  spreadsheetId: string,
  targetTabId?: number | null,
  targetTabName?: string | null
) {
  const spreadsheet = await sheets.spreadsheets.get({
    spreadsheetId,
    fields: "sheets.properties(sheetId,title)",
  });

  const tabs = (spreadsheet.data.sheets || [])
    .map((sheet) => sheet.properties)
    .filter(
      (properties): properties is { sheetId?: number | null; title?: string | null } =>
        Boolean(properties)
    );

  const byId =
    typeof targetTabId === "number"
      ? tabs.find((tab) => tab.sheetId === targetTabId)
      : undefined;

  if (byId?.sheetId != null && byId.title) {
    return { tabId: byId.sheetId, title: byId.title };
  }

  const byName = targetTabName
    ? tabs.find((tab) => tab.title === targetTabName)
    : undefined;

  if (byName?.sheetId != null && byName.title) {
    return { tabId: byName.sheetId, title: byName.title };
  }

  return createContactsTab(sheets, spreadsheetId);
}

function normalizeEmail(value: string) {
  return value.trim().toLowerCase();
}

function normalizePersonValue(value: string | null | undefined) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ");
}

function normalizePhone(value: string | null | undefined) {
  return String(value || "").replace(/\D/g, "");
}

export async function findExistingContactInSpreadsheet(
  sheets: SheetsClient,
  spreadsheetId: string,
  candidate: {
    email?: string | null;
    firstName?: string | null;
    lastName?: string | null;
    phone?: string | null;
  }
) {
  const spreadsheet = await sheets.spreadsheets.get({
    spreadsheetId,
    fields: "sheets.properties(sheetId,title)",
  });

  const candidateEmail = normalizeEmail(candidate.email || "");
  const candidateFirst = normalizePersonValue(candidate.firstName);
  const candidateLast = normalizePersonValue(candidate.lastName);
  const candidatePhone = normalizePhone(candidate.phone);

  for (const sheet of spreadsheet.data.sheets || []) {
    const title = sheet.properties?.title;
    if (!title) continue;

    const headerResponse = await sheets.spreadsheets.values.get({
      spreadsheetId,
      range: contactsHeaderRange(title),
      majorDimension: "ROWS",
    });

    const headerRow = headerResponse.data.values?.[0] || [];
    const isContactsTab =
      headerRow.length === CONTACT_HEADERS.length &&
      CONTACT_HEADERS.every(
        (header, index) => String(headerRow[index] || "").trim() === header
      );

    if (!isContactsTab) continue;

    const response = await sheets.spreadsheets.values.get({
      spreadsheetId,
      range: contactsDataRange(title),
      majorDimension: "ROWS",
    });

    for (const row of response.data.values || []) {
      const rowEmail = normalizeEmail(row[2] || "");

      if (candidateEmail && rowEmail && candidateEmail === rowEmail) {
        return { found: true, tabName: title, reason: "email" as const };
      }

      if (!candidateEmail && candidateFirst && candidateLast) {
        const rowFirst = normalizePersonValue(row[0]);
        const rowLast = normalizePersonValue(row[1]);
        const rowPhone = normalizePhone(row[3]);

        if (
          rowFirst === candidateFirst &&
          rowLast === candidateLast &&
          ((!candidatePhone && !rowPhone) ||
            (candidatePhone && rowPhone && candidatePhone === rowPhone))
        ) {
          return { found: true, tabName: title, reason: "name" as const };
        }
      }
    }
  }

  return {
    found: false,
    tabName: null,
    reason: null,
  };
}
