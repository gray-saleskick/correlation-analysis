import bcrypt from "bcryptjs";
import { cookies } from "next/headers";
import { verifyToken, COOKIE_NAME } from "./jwt";
import type { SessionPayload } from "./jwt";
import {
  getUserByEmail as dbGetUserByEmail,
  createUser as dbCreateUser,
  listUsers as dbListUsers,
  updateUserPassword as dbUpdateUserPassword,
  deleteUser as dbDeleteUser,
} from "./db";

// Re-export everything from jwt.ts so existing imports keep working
export { signToken, verifyToken, buildSessionCookie, buildLogoutCookie, COOKIE_NAME } from "./jwt";
export type { SessionPayload } from "./jwt";

// ── Password hashing ──────────────────────────────────────────────────────

const BCRYPT_ROUNDS = 10; // 10 rounds ≈ 100ms (vs 12 rounds ≈ 450ms). Still secure per OWASP.

export function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, BCRYPT_ROUNDS);
}

export async function verifyPassword(password: string, hash: string): Promise<boolean> {
  return bcrypt.compare(password, hash);
}

/** Check if a hash was made with older (more expensive) rounds and needs rehash */
export function needsRehash(hash: string): boolean {
  const rounds = bcrypt.getRounds(hash);
  return rounds > BCRYPT_ROUNDS;
}

// ── Cookie-based session (for server components & API routes) ─────────────
// Wrapped with React cache() so multiple calls within the same request
// (e.g. layout.tsx + page.tsx) only verify the JWT once.

import { cache } from "react";

export const getSession = cache(async (): Promise<SessionPayload | null> => {
  const cookieStore = await cookies();
  const token = cookieStore.get(COOKIE_NAME)?.value;
  if (!token) return null;
  return verifyToken(token);
});

// ── User queries ──────────────────────────────────────────────────────────

export async function getUserByEmail(email: string) {
  const normalizedEmail = email.toLowerCase().trim();
  return dbGetUserByEmail(normalizedEmail);
}

export async function getUserById(userId: string) {
  // db.ts doesn't have getUserById yet, but we can work around it
  // by listing all users and finding. For now, keep the same signature.
  const users = await dbListUsers();
  return users.find(u => u.id === userId) || null;
}

export async function createUser(email: string, password: string, name?: string) {
  const normalizedEmail = email.toLowerCase().trim();
  const hash = await hashPassword(password);
  const user = await dbCreateUser(normalizedEmail, hash, name?.trim());
  return { id: user.id, email: user.email, name: user.name, created_at: "" };
}

export async function listUsers() {
  return dbListUsers();
}

export async function updatePassword(userId: string, newPassword: string) {
  const hash = await hashPassword(newPassword);
  await dbUpdateUserPassword(userId, hash);
}

/** Update just the hash (used for background rehash on login) */
export async function updatePasswordHash(userId: string, newHash: string) {
  await dbUpdateUserPassword(userId, newHash);
}

export async function resetUserPassword(userId: string, newPassword: string) {
  // Admin reset — no current password required
  const hash = await hashPassword(newPassword);
  await dbUpdateUserPassword(userId, hash);
}

export async function deleteUser(userId: string) {
  const deleted = await dbDeleteUser(userId);
  if (!deleted) throw new Error("User not found");
}
