import { supabase } from "./supabase";
import type { ClientProfile } from "./types";

// ── Security: Validate IDs to prevent injection ──────────────────────────
function isValidId(id: string): boolean {
  return /^[a-z0-9][a-z0-9_-]{0,60}$/.test(id);
}

export function uid(): string {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}

export async function listClients(): Promise<
  { clientId: string; clientName: string; created_at: string; appCount: number }[]
> {
  const { data, error } = await supabase
    .from("clients")
    .select("client_id, profile")
    .neq("client_id", "__users__")
    .order("created_at", { ascending: true });

  if (error) {
    console.error("listClients error:", error.message);
    return [];
  }

  return (data ?? [])
    .map((row) => {
      const profile = row.profile as ClientProfile;
      return {
        clientId: profile.clientId,
        clientName: profile.clientName,
        created_at: profile.created_at,
        appCount: profile.applications.length,
      };
    })
    .sort((a, b) => a.clientName.localeCompare(b.clientName));
}

export async function readProfile(clientId: string): Promise<ClientProfile | null> {
  if (!isValidId(clientId)) return null;

  const { data, error } = await supabase
    .from("clients")
    .select("profile")
    .eq("client_id", clientId)
    .single();

  if (error || !data) return null;
  return data.profile as ClientProfile;
}

export async function writeProfile(clientId: string, profile: ClientProfile): Promise<void> {
  if (!isValidId(clientId)) throw new Error("Invalid clientId");

  profile.updated_at = new Date().toISOString();

  const { error } = await supabase
    .from("clients")
    .upsert(
      {
        client_id: clientId,
        profile,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "client_id" }
    );

  if (error) {
    console.error(`writeProfile ${clientId} error:`, error.message);
    throw new Error("Failed to write profile");
  }
}

export async function createClient(clientName: string): Promise<ClientProfile> {
  // Sanitize client name for ID
  const clientId =
    clientName
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 40) || "client";

  // Ensure unique ID by checking if it exists
  let finalId = clientId;
  let counter = 1;

  while (true) {
    const { data } = await supabase
      .from("clients")
      .select("client_id")
      .eq("client_id", finalId)
      .single();

    if (!data) break; // ID is available
    finalId = `${clientId}-${counter++}`;
    if (counter > 1000) throw new Error("Too many client name collisions");
  }

  const profile: ClientProfile = {
    clientId: finalId,
    clientName,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    applications: [],
  };

  const { error } = await supabase.from("clients").insert({
    client_id: finalId,
    profile,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  });

  if (error) {
    console.error("createClient error:", error.message);
    throw new Error("Failed to create client");
  }

  return profile;
}

export interface AggregateStats {
  totalClients: number;
  totalApplications: number;
  totalSubmissions: number;
  totalCallResults: number;
  totalFinancialRecords: number;
  totalQuestions: number;
  totalAuditsGenerated: number;
  totalGradingAuditsGenerated: number;
  totalBookings: number;
  totalShows: number;
  totalCloses: number;
}

export async function getAggregateStats(): Promise<AggregateStats> {
  const stats: AggregateStats = {
    totalClients: 0,
    totalApplications: 0,
    totalSubmissions: 0,
    totalCallResults: 0,
    totalFinancialRecords: 0,
    totalQuestions: 0,
    totalAuditsGenerated: 0,
    totalGradingAuditsGenerated: 0,
    totalBookings: 0,
    totalShows: 0,
    totalCloses: 0,
  };

  const { data, error } = await supabase.from("clients").select("client_id, profile").neq("client_id", "__users__");

  if (error || !data) return stats;

  for (const row of data) {
    const profile = row.profile as ClientProfile;
    stats.totalClients++;
    for (const app of profile.applications) {
      stats.totalApplications++;
      stats.totalSubmissions += app.submissions?.length ?? 0;
      stats.totalFinancialRecords += app.financial_records?.length ?? 0;
      stats.totalQuestions += app.questions?.length ?? 0;
      if (app.audit_analysis) stats.totalAuditsGenerated++;
      if (app.grading_audit_analysis) stats.totalGradingAuditsGenerated++;

      const callResults = app.call_results ?? [];
      stats.totalCallResults += callResults.length;
      for (const cr of callResults) {
        if (cr.booked) stats.totalBookings++;
        if (cr.showed) stats.totalShows++;
        if (cr.closed) stats.totalCloses++;
      }
    }
  }

  return stats;
}

export async function deleteClient(clientId: string): Promise<boolean> {
  if (!isValidId(clientId)) return false;

  const { error, count } = await supabase
    .from("clients")
    .delete({ count: "exact" })
    .eq("client_id", clientId);

  if (error) {
    console.error(`deleteClient ${clientId} error:`, error.message);
    return false;
  }

  return (count ?? 0) > 0;
}
