import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { hasWebhookAccess } from "@/lib/featureFlags";
import { supabase } from "@/lib/supabase";

export const dynamic = "force-dynamic";
export const maxDuration = 10;

export async function GET() {
  try {
    const session = await getSession();
    if (!session || !hasWebhookAccess(session.email)) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 403 });
    }

    // Only fetch the fields we need via JSONB projection
    const { data, error } = await supabase
      .from("clients")
      .select("client_id, profile->clientId, profile->clientName, profile->applications")
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

    for (const row of data as Record<string, unknown>[]) {
      const clientId = row.clientId as string;
      const clientName = row.clientName as string;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const applications = row.applications as any[] | null;
      if (!applications) continue;

      for (const app of applications) {
        if (app.webhook_config) {
          apps.push({
            clientId,
            clientName,
            appId: app.id,
            appTitle: app.title,
            source: app.webhook_config.source,
            lastReceived: app.webhook_config.last_received_at,
            pendingCount: (app.pending_webhook_submissions ?? []).filter(
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              (p: any) => p.status === "pending"
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
