import OpenAI from "openai";

export type ContactExtraction = {
  is_human: boolean;
  first_name: string | null;
  last_name: string | null;
  email: string | null;
  phone: string | null;
  fax: string | null;
  title: string | null;
  address: string | null;
};

let client: OpenAI | null = null;

function getOpenAI() {
  if (!client) {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) throw new Error("OPENAI_API_KEY is not configured.");
    client = new OpenAI({ apiKey });
  }
  return client;
}

const AUTOMATED_LOCAL_PARTS = new Set([
  "bounce",
  "bounces",
  "daemon",
  "do-not-reply",
  "donotreply",
  "mailer-daemon",
  "marketing",
  "noreply",
  "no-reply",
  "newsletter",
  "newsletters",
  "notifications",
  "notify",
  "postmaster",
  "updates",
]);

const AUTOMATED_DOMAIN_MARKERS = [
  "mailchimp",
  "sendgrid",
  "amazonses",
  "mailer",
  "notification",
  "notifications",
  "marketing",
  "newsletter",
  "newsletters",
];

function extractAddress(value: string) {
  const angleMatch = value.match(/<([^>]+)>/);
  const raw = angleMatch?.[1] || value;
  const match = raw.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
  return match?.[0]?.trim().toLowerCase() || "";
}

export function isObviousAutomatedSender(
  fromHeader: string,
  headers: Record<string, string> = {}
) {
  const email = extractAddress(fromHeader);
  const [localPart, domain] = email.split("@");

  if (!email || !localPart || !domain) return false;

  if (AUTOMATED_LOCAL_PARTS.has(localPart)) return true;

  if (
    AUTOMATED_LOCAL_PARTS.has(localPart.replace(/[_-]+/g, ""))
  ) {
    return true;
  }

  if (AUTOMATED_DOMAIN_MARKERS.some((marker) => domain.includes(marker))) {
    return true;
  }

  const autoSubmitted = (headers["auto-submitted"] || "").toLowerCase();
  const precedence = (headers["precedence"] || "").toLowerCase();
  const listUnsubscribe = headers["list-unsubscribe"] || "";
  const xAutoResponseSuppress = (
    headers["x-auto-response-suppress"] || ""
  ).toLowerCase();

  if (autoSubmitted && autoSubmitted !== "no") return true;
  if (precedence === "bulk" || precedence === "list" || precedence === "junk") {
    return true;
  }
  if (listUnsubscribe.trim()) return true;
  if (xAutoResponseSuppress.trim()) return true;

  return false;
}

function normalizeResult(value: unknown): ContactExtraction {
  const parsed = (value || {}) as Record<string, unknown>;

  return {
    is_human: parsed.is_human === true,
    first_name: typeof parsed.first_name === "string" ? parsed.first_name.trim() || null : null,
    last_name: typeof parsed.last_name === "string" ? parsed.last_name.trim() || null : null,
    email: typeof parsed.email === "string" ? parsed.email.trim().toLowerCase() || null : null,
    phone: typeof parsed.phone === "string" ? parsed.phone.trim() || null : null,
    fax: typeof parsed.fax === "string" ? parsed.fax.trim() || null : null,
    title: typeof parsed.title === "string" ? parsed.title.trim() || null : null,
    address: typeof parsed.address === "string" ? parsed.address.trim() || null : null,
  };
}

export async function analyzeEmailForContact(input: {
  from: string;
  subject: string;
  snippet: string;
  headers?: Record<string, string>;
}) {
  if (isObviousAutomatedSender(input.from, input.headers)) {
    return {
      ...normalizeResult({ is_human: false }),
      reason: "deterministic_automated_sender",
      usedModel: false,
    };
  }

  const response = await getOpenAI().chat.completions.create({
    model: "gpt-4o-mini",
    messages: [
      {
        role: "system",
        content:
          "Analyze the email sender and message metadata. Decide whether it is a likely human-to-human business email and, only when it is, extract the sender's contact details. Return JSON only. Treat generic notifications, newsletters, automated alerts, transactional messages, recruiting blasts, marketing mail, system mail, and bulk mail as non-human. Do not invent contact details. Use the sender email when it is a reliable personal/business address.",
      },
      {
        role: "user",
        content:
          "From: " + input.from +
          "\nSubject: " + input.subject +
          "\nSnippet: " + input.snippet +
          "\nHeaders: " + JSON.stringify(input.headers || {}),
      },
    ],
    response_format: { type: "json_object" },
    temperature: 0,
  });

  let parsed: unknown = {};
  const content = response.choices[0]?.message?.content;

  if (content) {
    try {
      parsed = JSON.parse(content);
    } catch {
      throw new Error("OpenAI returned invalid JSON.");
    }
  }

  const result = normalizeResult(parsed);

  if (!result.is_human) {
    return {
      ...result,
      email: null,
      usedModel: true,
      reason: "model_filtered_sender",
    };
  }

  const senderEmail = extractAddress(input.from);
  return {
    ...result,
    email: result.email || senderEmail || null,
    usedModel: true,
    reason: "model_human_sender",
  };
}
