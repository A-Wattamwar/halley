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
 *
 * READ-ONLY DEMO (HALLEY_READ_ONLY=true): hard-blocks every mutating HTTP request
 *   so a public demo can't write fixtures or trigger CI/bisect. Enforced FIRST,
 *   before the auth pass-through, so it applies even when HALLEY_AUTH_REQUIRED=false
 *   (the typical demo config). On /api/*, any non-GET/HEAD/OPTIONS method → 403,
 *   except /api/auth/* (sign-in/CSRF). The SSE live route GET /api/runs/[id]/live
 *   is a GET, so it is allowed by the safe-method check. The flag is the security
 *   boundary; the NEXT_PUBLIC_* mirror only hides buttons. See read-only-guard-spec.
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

// Read-only demo guard (security boundary). Methods that never mutate.
const READ_ONLY = process.env.HALLEY_READ_ONLY === "true";
const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

// Non-GET paths still allowed in read-only mode (Auth.js sign-in/CSRF POST).
function isReadOnlyAllowlisted(pathname: string): boolean {
  return pathname.startsWith("/api/auth");
}

export default withAuth(
  function middleware(req: NextRequestWithAuth) {
    // Read-only demo: block any mutating /api/* request BEFORE auth logic, so it
    // holds even when HALLEY_AUTH_REQUIRED=false. GET/HEAD/OPTIONS pass; the SSE
    // live route is a GET and is covered. /api/auth/* is allowlisted.
    if (
      READ_ONLY &&
      req.nextUrl.pathname.startsWith("/api/") &&
      !SAFE_METHODS.has(req.method) &&
      !isReadOnlyAllowlisted(req.nextUrl.pathname)
    ) {
      return NextResponse.json({ error: "read-only demo" }, { status: 403 });
    }

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
