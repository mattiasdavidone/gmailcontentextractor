import { createHash, randomBytes, scryptSync, timingSafeEqual } from "crypto";
import { cookies } from "next/headers";
import { createClient } from "@supabase/supabase-js";

const SESSION_COOKIE = "gce_session";
const SESSION_DAYS = 30;

function supabaseAdmin() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  );
}

function hashToken(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

export function hashPassword(password: string) {
  const salt = randomBytes(16).toString("hex");
  const derived = scryptSync(password, salt, 64).toString("hex");
  return `${salt}:${derived}`;
}

export function verifyPassword(password: string, stored: string) {
  const [salt, expected] = stored.split(":");

  if (!salt || !expected || !/^[0-9a-f]+$/i.test(expected)) {
    return false;
  }

  try {
    const actual = scryptSync(password, salt, 64);
    const expectedBytes = Buffer.from(expected, "hex");

    if (expectedBytes.length !== actual.length) {
      return false;
    }

    return timingSafeEqual(actual, expectedBytes);
  } catch {
    return false;
  }
}

export async function createSession(userId: string) {
  const supabase = supabaseAdmin();
  const token = randomBytes(32).toString("hex");
  const tokenHash = hashToken(token);

  const expiresAt = new Date(
    Date.now() + SESSION_DAYS * 24 * 60 * 60 * 1000
  ).toISOString();

  const { error } = await supabase.from("user_sessions").insert({
    user_id: userId,
    token_hash: tokenHash,
    expires_at: expiresAt,
  });

  if (error) {
    throw new Error(error.message);
  }

  const cookieStore = await cookies();

  cookieStore.set(SESSION_COOKIE, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: SESSION_DAYS * 24 * 60 * 60,
  });
}

export async function clearSession() {
  const cookieStore = await cookies();
  const token = cookieStore.get(SESSION_COOKIE)?.value;

  if (token) {
    const supabase = supabaseAdmin();
    await supabase
      .from("user_sessions")
      .delete()
      .eq("token_hash", hashToken(token));
  }

  cookieStore.delete(SESSION_COOKIE);
}

export async function getCurrentUser() {
  const cookieStore = await cookies();
  const token = cookieStore.get(SESSION_COOKIE)?.value;

  if (!token) return null;

  const supabase = supabaseAdmin();

  const { data, error } = await supabase
    .from("user_sessions")
    .select("expires_at, app_users(*)")
    .eq("token_hash", hashToken(token))
    .maybeSingle();

  if (error || !data?.app_users) return null;

  if (new Date(data.expires_at).getTime() <= Date.now()) {
    await supabase
      .from("user_sessions")
      .delete()
      .eq("token_hash", hashToken(token));

    cookieStore.delete(SESSION_COOKIE);
    return null;
  }

  const user = Array.isArray(data.app_users)
    ? data.app_users[0]
    : data.app_users;

  return user as {
    id: string;
    email: string;
    created_at: string;
  };
}

export async function requireUser() {
  const user = await getCurrentUser();

  if (!user) {
    throw new Error("AUTH_REQUIRED");
  }

  return user;
}
