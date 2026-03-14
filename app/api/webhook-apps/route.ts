import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { hasWebhookAccess } from "@/lib/featureFlags";
import { supabase } from "@/lib/supabase";
import type { ClientProfile } from "@/lib/types";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const session = await getSession();
    if (!session || !hasWebhookAccess(session.email)) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 403 });
    }

    const { data, error } = await supabase
      .from("clients")
      .select("client_id, profile")
      .neq("client_id", "__users__");

    if (error || !data) {
      return NextResponse.json({ apps: [] });
    }

    const apps: {
      clientId: string;
      clientName: string;
      appId: string;
      appTitle: string;
      source: string;
      lastReceived?: string;
      pendingCount: number;
    }[] = [];

    for (const row of data) {
      const profile = row.profile as ClientProfile;
      for (const app of profile.applications) {
        if (app.webhook_config) {
          apps.push({
            clientId: profile.clientId,
            clientName: profile.clientName,
            appId: app.id,
            appTitle: app.title,
            source: app.webhook_config.source,
            lastReceived: app.webhook_config.last_received_at,
            pendingCount: (app.pending_webhook_submissions ?? []).filter(
              (p) => p.status === "pending"
            ).length,
          });
        }
      }
    }

    return NextResponse.json({ apps });
  } catch (err) {
    console.error("GET /api/webhook-apps error:", err);
    return NextResponse.json({ error: "Internal error" }, { status: 500 });
  }
}
