import { createClient } from "@supabase/supabase-js";

const supabaseUrl = process.env.SUPABASE_URL!;
const supabaseKey = process.env.SUPABASE_SERVICE_KEY!;

const SUPABASE_TIMEOUT_MS = 8_000; // 8 second timeout for all Supabase queries

export const supabase = createClient(supabaseUrl, supabaseKey, {
  global: {
    fetch: (url, options = {}) => {
      // Add timeout to prevent hanging when Supabase is slow/sleeping
      // Skip during build (AbortController + no-store triggers dynamic server error)
      if (process.env.NEXT_PHASE === "phase-production-build") {
        return fetch(url, { ...options, cache: "no-store" });
      }
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), SUPABASE_TIMEOUT_MS);
      return fetch(url, {
        ...options,
        cache: "no-store",
        signal: controller.signal,
      }).finally(() => clearTimeout(timeoutId));
    },
  },
});
