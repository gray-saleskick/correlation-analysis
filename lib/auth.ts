import bcrypt from "bcryptjs";
import { cookies } from "next/headers";
import { supabase } from "./supabase";
import { verifyToken, COOKIE_NAME } from "./jwt";
import type { SessionPayload } from "./jwt";

// Re-export everything from jwt.ts so existing imports keep working
export { signToken, verifyToken, buildSessionCookie, buildLogoutCookie, COOKIE_NAME } from "./jwt";
export type { SessionPayload } from "./jwt";

// We store users as JSON in the existing "clients" table
// using a reserved client_id of "__users__"
const USERS_ROW_ID = "__users__";

interface StoredUser {
  id: string;
  email: string;
  password_hash: string;
  name: string | null;
  created_at: string;
}

interface UsersStore {
  users: StoredUser[];
}

// ── Internal helpers to read/write users from the clients table ──────────

async function readUsersStore(): Promise<UsersStore> {
  const { data, error } = await supabase
    .from("clients")
    .select("profile")
    .eq("client_id", USERS_ROW_ID)
    .single();

  if (error || !data) return { users: [] };
  const store = data.profile as UsersStore;
  return store?.users ? store : { users: [] };
}

async function writeUsersStore(store: UsersStore): Promise<void> {
  const { error } = await supabase
    .from("clients")
    .upsert(
      {
        client_id: USERS_ROW_ID,
        profile: store,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "client_id" }
    );

  if (error) {
    console.error("writeUsersStore error:", error.message);
    throw new Error("Failed to save users");
  }
}

// ── Password hashing ──────────────────────────────────────────────────────

export function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, 12);
}

export function verifyPassword(password: string, hash: string): Promise<boolean> {
  return bcrypt.compare(password, hash);
}

// ── Cookie-based session (for server components & API routes) ─────────────

export async function getSession(): Promise<SessionPayload | null> {
  const cookieStore = await cookies();
  const token = cookieStore.get(COOKIE_NAME)?.value;
  if (!token) return null;
  return verifyToken(token);
}

// ── User queries ──────────────────────────────────────────────────────────

function generateId(): string {
  return crypto.randomUUID();
}

export async function getUserByEmail(email: string) {
  const store = await readUsersStore();
  const normalizedEmail = email.toLowerCase().trim();
  const user = store.users.find(u => u.email === normalizedEmail);
  return user || null;
}

export async function getUserById(userId: string) {
  const store = await readUsersStore();
  const user = store.users.find(u => u.id === userId);
  return user || null;
}

export async function createUser(email: string, password: string, name?: string) {
  const store = await readUsersStore();
  const normalizedEmail = email.toLowerCase().trim();

  // Check if already exists
  if (store.users.some(u => u.email === normalizedEmail)) {
    throw new Error("A user with this email already exists");
  }

  const hash = await hashPassword(password);
  const newUser: StoredUser = {
    id: generateId(),
    email: normalizedEmail,
    password_hash: hash,
    name: name?.trim() || null,
    created_at: new Date().toISOString(),
  };

  store.users.push(newUser);
  await writeUsersStore(store);

  return { id: newUser.id, email: newUser.email, name: newUser.name, created_at: newUser.created_at };
}

export async function listUsers() {
  const store = await readUsersStore();
  return store.users.map(u => ({
    id: u.id,
    email: u.email,
    name: u.name,
    created_at: u.created_at,
  }));
}

export async function updatePassword(userId: string, newPassword: string) {
  const store = await readUsersStore();
  const user = store.users.find(u => u.id === userId);
  if (!user) throw new Error("User not found");

  user.password_hash = await hashPassword(newPassword);
  await writeUsersStore(store);
}

export async function resetUserPassword(userId: string, newPassword: string) {
  // Admin reset — no current password required
  const store = await readUsersStore();
  const user = store.users.find(u => u.id === userId);
  if (!user) throw new Error("User not found");

  user.password_hash = await hashPassword(newPassword);
  await writeUsersStore(store);
}

export async function deleteUser(userId: string) {
  const store = await readUsersStore();
  const idx = store.users.findIndex(u => u.id === userId);
  if (idx === -1) throw new Error("User not found");

  store.users.splice(idx, 1);
  await writeUsersStore(store);
}
