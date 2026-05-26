/**
 * /api/auth/[...nextauth] — Auth.js v4 catch-all route handler.
 * Handles sign-in, sign-out, session, CSRF, and callback endpoints.
 */

import NextAuth from "next-auth";
import { authOptions } from "@/auth";

const handler = NextAuth(authOptions);
export { handler as GET, handler as POST };
