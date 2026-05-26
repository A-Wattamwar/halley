/**
 * app/settings/keys/actions.ts — Server Actions for API key management.
 *
 * Phase 4 Day 3. No API route — Server Actions only (D-12 compatible,
 * no extra route file needed).
 *
 * Key format: hlly_<base62(32 random bytes)>
 *   - Total length: 5 + ~43 chars = ~48 chars
 *   - Prefix stored in clear: first 12 chars of the full key (hlly_ + 7)
 *     → enough to identify which key was used without enabling auth.
 *   - Hash stored: SHA-256 hex of the full raw key.
 *     SHA-256 is acceptable here because:
 *       (a) the key is 32 random bytes (256 bits of entropy) — brute-force
 *           is infeasible regardless of hash speed.
 *       (b) bcrypt is for low-entropy passwords. High-entropy tokens use
 *           fast hashes (GitHub, Stripe, npm all use SHA-256 for API keys).
 *   - Full key shown exactly once at creation; never stored, never logged.
 */

"use server";

import { Pool } from "pg";
import crypto from "crypto";
import { revalidatePath } from "next/cache";
import { getServerSession } from "next-auth";
import { authOptions } from "@/auth";
import { DEV_PROJECT_ID } from "@/lib/session";

// ── Postgres pool (shared with auth.ts) ───────────────────────────────────
// Next.js module cache keeps this alive across requests in the same process.

const pool = new Pool({
  connectionString:
    process.env.POSTGRES_URL ??
    "postgresql://halley:halley@localhost:5432/halley",
  max: 5,
});

// ── Auth bypass (D-15) ────────────────────────────────────────────────────

const AUTH_REQUIRED = process.env.HALLEY_AUTH_REQUIRED !== "false";

async function getProjectId(): Promise<string> {
  if (!AUTH_REQUIRED) return DEV_PROJECT_ID;
  const session = await getServerSession(authOptions);
  if (!session) throw new Error("Unauthenticated");
  // Day 2 note: all authenticated users map to dev-local for now.
  // Day 3 (this file) uses the same convention.
  return DEV_PROJECT_ID;
}

// ── Key generation ────────────────────────────────────────────────────────

const BASE62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

/**
 * Encode a Buffer as a base62 string.
 * Simple byte-by-byte encoding (not arbitrary-precision bignum) — fast and
 * sufficient for random tokens where length variance is acceptable.
 */
function base62Encode(buf: Buffer): string {
  let result = "";
  Array.from(buf).forEach((byte) => {
    result += BASE62[byte % 62];
  });
  return result;
}

/**
 * Generate a new API key.
 * Returns { rawKey, hash, prefix } where:
 *   rawKey — the full key to show the user once.
 *   hash   — SHA-256 hex to store in Postgres.
 *   prefix — first 12 chars of rawKey to display permanently.
 */
function generateApiKey(): { rawKey: string; hash: string; prefix: string } {
  const randomBytes = crypto.randomBytes(32);
  const token  = base62Encode(randomBytes);
  const rawKey = `hlly_${token}`;
  const hash   = crypto.createHash("sha256").update(rawKey).digest("hex");
  const prefix = rawKey.slice(0, 12); // "hlly_" + 7 chars
  return { rawKey, hash, prefix };
}

// ── Server Actions ────────────────────────────────────────────────────────

export interface CreateKeyResult {
  ok: true;
  rawKey: string; // shown once — never stored
  prefix: string;
  id: string;
}
export interface ActionError {
  ok: false;
  error: string;
}

/**
 * createApiKey — generate + persist a new API key.
 * Returns the raw key (shown once) on success.
 */
export async function createApiKey(
  formData: FormData,
): Promise<CreateKeyResult | ActionError> {
  try {
    const name = (formData.get("name") as string | null)?.trim() ?? "";
    if (!name) return { ok: false, error: "Name is required." };
    if (name.length > 64) return { ok: false, error: "Name must be ≤ 64 characters." };

    const projectId = await getProjectId();
    const { rawKey, hash, prefix } = generateApiKey();
    const id = crypto.randomUUID();

    await pool.query(
      `INSERT INTO api_keys (id, project_id, key_hash, prefix, name, created_at)
       VALUES ($1, $2, $3, $4, $5, now())`,
      [id, projectId, hash, prefix, name],
    );

    revalidatePath("/settings/keys");
    return { ok: true, rawKey, prefix, id };
  } catch (err) {
    console.error("createApiKey error:", err);
    return { ok: false, error: "Failed to create key. Please try again." };
  }
}

/**
 * revokeApiKey — soft-delete: sets revoked_at = now().
 * Only revokes keys belonging to the session's project.
 */
export async function revokeApiKey(
  keyId: string,
): Promise<{ ok: true } | ActionError> {
  try {
    const projectId = await getProjectId();

    const result = await pool.query(
      `UPDATE api_keys
       SET revoked_at = now()
       WHERE id = $1
         AND project_id = $2
         AND revoked_at IS NULL`,
      [keyId, projectId],
    );

    if (result.rowCount === 0) {
      return { ok: false, error: "Key not found or already revoked." };
    }

    revalidatePath("/settings/keys");
    return { ok: true };
  } catch (err) {
    console.error("revokeApiKey error:", err);
    return { ok: false, error: "Failed to revoke key. Please try again." };
  }
}

// ── Query helper (called from the Server Component page) ──────────────────

export interface ApiKeyRow {
  id: string;
  prefix: string;
  name: string;
  created_at: string; // ISO string
}

/**
 * listApiKeys — returns active (non-revoked) keys for the session's project.
 * Called directly from the Server Component (no fetch, no API route).
 */
export async function listApiKeys(): Promise<ApiKeyRow[]> {
  const projectId = await getProjectId();

  // pg returns TIMESTAMPTZ columns as JS Date objects at runtime even though
  // our public ApiKeyRow interface declares created_at as string.
  // Use a separate raw type so instanceof Date is type-safe.
  interface RawKeyRow {
    id: string;
    prefix: string;
    name: string;
    created_at: Date | string;
  }

  const result = await pool.query<RawKeyRow>(
    `SELECT id, prefix, name, created_at
     FROM api_keys
     WHERE project_id = $1
       AND revoked_at IS NULL
     ORDER BY created_at DESC`,
    [projectId],
  );

  return result.rows.map((r) => ({
    id:         r.id,
    prefix:     r.prefix,
    name:       r.name,
    created_at: r.created_at instanceof Date
      ? r.created_at.toISOString()
      : String(r.created_at),
  }));
}
