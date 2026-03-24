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

    // Query relational tables directly
    const { data: webhookConfigs, error: wcError } = await supabase
      .from("webhook_configs")
      .select("application_id, source, last_received_at, enabled, applications!inner(id, title, client_id, clients!inner(client_id, client_name))");

    if (wcError || !webhookConfigs) {
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

    // Get pending counts for each application
    for (const wc of webhookConfigs as Record<string, unknown>[]) {
      const application = wc.applications as Record<string, unknown>;
      const client = application.clients as Record<string, unknown>;

      // Count pending webhook submissions
      const { count: pendingCount } = await supabase
        .from("pending_webhook_submissions")
        .select("*", { count: "exact", head: true })
        .eq("application_id", wc.application_id as string)
        .eq("status", "pending");

      apps.push({
        clientId: client.client_id as string,
        clientName: client.client_name as string,
        appId: application.id as string,
        appTitle: application.title as string,
        source: wc.source as string,
        lastReceived: (wc.last_received_at as string) ?? undefined,
        pendingCount: pendingCount ?? 0,
      });
    }

    return NextResponse.json({ apps });
  } catch (err) {
    console.error("GET /api/webhook-apps error:", err);
    return NextResponse.json({ error: "Internal error" }, { status: 500 });
  }
}
