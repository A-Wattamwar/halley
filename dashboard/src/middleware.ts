/**
 * middleware.ts — Auth.js route protection (Phase 4 Day 1).
 *
 * D-14: CredentialsProvider only. No OAuth.
 * D-15: If HALLEY_AUTH_REQUIRED=false, all routes pass through unauthenticated.
 *       This preserves `make smoke` and local dev without needing a session.
 *
 * Public paths (never redirected to /login):
 *   /login         — sign-in page
 *   /api/auth/*    — Auth.js endpoints (sign-in, CSRF, session, etc.)
 *   /api/health    — ingester health probe
 */

import { withAuth } from "next-auth/middleware";
import { NextResponse } from "next/server";
import type { NextRequestWithAuth } from "next-auth/middleware";

// Public path prefixes — never redirected.
const PUBLIC_PREFIXES = ["/login", "/api/auth", "/api/health"];

function isPublic(pathname: string): boolean {
  return PUBLIC_PREFIXES.some((p) => pathname.startsWith(p));
}

// D-15: dev-mode bypass — set HALLEY_AUTH_REQUIRED=false to skip auth.
const AUTH_REQUIRED = process.env.HALLEY_AUTH_REQUIRED !== "false";

export default withAuth(
  function middleware(req: NextRequestWithAuth) {
    // If auth is disabled globally (D-15) or the path is public, pass through.
    if (!AUTH_REQUIRED || isPublic(req.nextUrl.pathname)) {
      return NextResponse.next();
    }

    // withAuth already handled the redirect if the token is absent —
    // if we reach here, the user is authenticated.
    return NextResponse.next();
  },
  {
    callbacks: {
      authorized({ req, token }) {
        // Public paths and auth-disabled mode are always "authorized"
        // so withAuth doesn't redirect them.
        if (!AUTH_REQUIRED || isPublic(req.nextUrl.pathname)) return true;
        // Otherwise require a valid JWT token.
        return !!token;
      },
    },
    pages: {
      signIn: "/login",
    },
  },
);

export const config = {
  matcher: [
    // Run on all routes except Next.js static files.
    "/((?!_next/static|_next/image|favicon\\.ico).*)",
  ],
};
