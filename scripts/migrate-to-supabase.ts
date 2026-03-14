// One-time migration script: reads all existing clients from the filesystem
// and inserts them into Supabase.
//
// Run with: npx tsx scripts/migrate-to-supabase.ts

import fs from "fs";
import path from "path";
import { config } from "dotenv";
import { createClient } from "@supabase/supabase-js";

// Load env vars from .env.local
config({ path: path.join(process.cwd(), ".env.local") });

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_KEY;

if (!supabaseUrl || !supabaseKey) {
  console.error("❌ Missing SUPABASE_URL or SUPABASE_SERVICE_KEY in .env.local");
  process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseKey);
const CLIENTS_DIR = path.join(process.cwd(), "clients");

async function migrate() {
  if (!fs.existsSync(CLIENTS_DIR)) {
    console.log("No clients/ directory found. Nothing to migrate.");
    return;
  }

  const entries = fs.readdirSync(CLIENTS_DIR, { withFileTypes: true });
  let success = 0;
  let skipped = 0;
  let failed = 0;

  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) continue;

    const profilePath = path.join(CLIENTS_DIR, entry.name, "profile.json");
    if (!fs.existsSync(profilePath)) {
      console.log(`  ⏭  ${entry.name} — no profile.json, skipping`);
      skipped++;
      continue;
    }

    try {
      const raw = fs.readFileSync(profilePath, "utf-8");
      const profile = JSON.parse(raw);

      const { error } = await supabase.from("clients").upsert(
        {
          client_id: profile.clientId ?? entry.name,
          profile,
          created_at: profile.created_at ?? new Date().toISOString(),
          updated_at: profile.updated_at ?? new Date().toISOString(),
        },
        { onConflict: "client_id" }
      );

      if (error) {
        console.error(`  ❌ ${entry.name} — ${error.message}`);
        failed++;
      } else {
        console.log(`  ✅ ${entry.name} — migrated (${profile.applications?.length ?? 0} apps)`);
        success++;
      }
    } catch (err) {
      console.error(`  ❌ ${entry.name} — ${err instanceof Error ? err.message : err}`);
      failed++;
    }
  }

  console.log(`\n📊 Migration complete: ${success} migrated, ${skipped} skipped, ${failed} failed`);
}

migrate().catch((err) => {
  console.error("Migration failed:", err);
  process.exit(1);
});
