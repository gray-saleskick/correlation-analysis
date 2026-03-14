/**
 * Seed the initial user account.
 * Uses the same "clients" table as the app (row with client_id = "__users__").
 * Run: npx tsx scripts/seed-user.ts
 */

import dotenv from "dotenv";
dotenv.config({ path: ".env.local" });
import { createClient } from "@supabase/supabase-js";
import bcrypt from "bcryptjs";

const supabaseUrl = process.env.SUPABASE_URL!;
const supabaseKey = process.env.SUPABASE_SERVICE_KEY!;
const supabase = createClient(supabaseUrl, supabaseKey);

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

async function seed() {
  const email = "gray@saleskick.com";
  const password = "Saleskick!26";
  const name = "Gray Martin";

  // Read existing users store
  const { data } = await supabase
    .from("clients")
    .select("profile")
    .eq("client_id", USERS_ROW_ID)
    .single();

  const store: UsersStore = (data?.profile as UsersStore)?.users
    ? (data.profile as UsersStore)
    : { users: [] };

  // Check if already exists
  if (store.users.some((u) => u.email === email)) {
    console.log(`User ${email} already exists. Skipping.`);
    return;
  }

  // Create user
  const hash = await bcrypt.hash(password, 12);
  const newUser: StoredUser = {
    id: crypto.randomUUID(),
    email,
    password_hash: hash,
    name,
    created_at: new Date().toISOString(),
  };

  store.users.push(newUser);

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
    console.error("Failed to create user:", error.message);
    process.exit(1);
  }

  console.log("Created user:", { id: newUser.id, email: newUser.email, name: newUser.name });
}

seed().catch(console.error);
