import { NextRequest, NextResponse } from "next/server";

const SESSION_COOKIE = "gce_session";

export function proxy(request: NextRequest) {
  const pathname = request.nextUrl.pathname;
  const token = request.cookies.get(SESSION_COOKIE)?.value;

  const publicPath =
    pathname === "/login" ||
    pathname === "/signup" ||
    pathname.startsWith("/api/auth/");

  if (!token && !publicPath) {
    if (pathname.startsWith("/api/")) {
      return NextResponse.json({ error: "AUTH_REQUIRED" }, { status: 401 });
    }

    return NextResponse.redirect(new URL("/login", request.url));
  }

  if (token && (pathname === "/login" || pathname === "/signup")) {
    return NextResponse.redirect(new URL("/", request.url));
  }

  return NextResponse.next();
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
