import { NextRequest, NextResponse } from "next/server";
import { verifyToken } from "./lib/jwt";

const PUBLIC_PATHS = [
  "/login",
  "/api/auth/login",
  "/share/",
  "/api/share/",
];

const STATIC_PREFIXES = [
  "/_next/",
  "/favicon.ico",
  "/logo.png",
];

export async function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;

  // Always allow static assets
  if (STATIC_PREFIXES.some(p => pathname.startsWith(p))) {
    return NextResponse.next();
  }

  // Always allow public paths
  if (PUBLIC_PATHS.some(p => pathname.startsWith(p))) {
    return NextResponse.next();
  }

  // Check session cookie
  const token = req.cookies.get("sk_session")?.value;
  const session = token ? await verifyToken(token) : null;

  if (!session) {
    // API routes get 401
    if (pathname.startsWith("/api/")) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    // Pages redirect to login
    const loginUrl = req.nextUrl.clone();
    loginUrl.pathname = "/login";
    loginUrl.searchParams.set("from", pathname);
    return NextResponse.redirect(loginUrl);
  }

  return NextResponse.next();
}

export const config = {
  matcher: [
    // Match everything except static files
    "/((?!_next/static|_next/image|favicon.ico).*)",
  ],
};
