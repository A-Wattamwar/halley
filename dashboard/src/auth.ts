/**
 * auth.ts — Auth.js v4 configuration (Phase 4 Day 1).
 *
 * D-14: CredentialsProvider only. No OAuth providers.
 * D-15: HALLEY_AUTH_REQUIRED=false bypasses auth for local dev / smoke tests.
 *
 * Adapter: @auth/pg-adapter with the shared Postgres pool.
 * Strategy: "jwt" — no database session writes on every request.
 *   (We still keep the sessions table for the adapter; it's just not the
 *   primary session storage strategy, which keeps ingest unaffected.)
 */

import NextAuth from "next-auth";
import type { NextAuthOptions } from "next-auth";
import CredentialsProvider from "next-auth/providers/credentials";
import PostgresAdapter from "@auth/pg-adapter";
import { Pool } from "pg";
import bcrypt from "bcryptjs";

// ── Postgres pool ─────────────────────────────────────────────────────────
// Reuse a module-level pool. Next.js hot-reload in dev can create multiple
// module instances; the pool handles that gracefully.

const pool = new Pool({
  connectionString:
    process.env.POSTGRES_URL ??
    "postgresql://halley:halley@localhost:5433/halley",
  max: 5,
});

// ── Auth.js options ───────────────────────────────────────────────────────

export const authOptions: NextAuthOptions = {
  adapter: PostgresAdapter(pool),

  session: {
    strategy: "jwt",
  },

  pages: {
    signIn: "/login",
  },

  providers: [
    CredentialsProvider({
      name: "Email + Password",
      credentials: {
        email:    { label: "Email",    type: "email" },
        password: { label: "Password", type: "password" },
      },

      async authorize(credentials) {
        if (!credentials?.email || !credentials?.password) return null;

        const result = await pool.query<{
          id: string;
          email: string;
          password_hash: string;
        }>(
          "SELECT id, email, password_hash FROM users WHERE email = $1 LIMIT 1",
          [credentials.email.toLowerCase().trim()],
        );

        const user = result.rows[0];
        if (!user) return null;

        const valid = await bcrypt.compare(credentials.password, user.password_hash);
        if (!valid) return null;

        return { id: user.id, email: user.email };
      },
    }),
  ],

  callbacks: {
    // Persist the user id in the JWT so server components can read it.
    async jwt({ token, user }) {
      if (user) token.sub = user.id;
      return token;
    },
    async session({ session, token }) {
      if (session.user && token.sub) {
        (session.user as { id?: string }).id = token.sub;
      }
      return session;
    },
  },

  secret: process.env.NEXTAUTH_SECRET ?? "halley-dev-secret-change-in-prod",
};

export default NextAuth(authOptions);
