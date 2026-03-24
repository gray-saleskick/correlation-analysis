import { NextRequest, NextResponse } from "next/server";
import { readClient, createApplication, listApplications } from "@/lib/db";

export const dynamic = "force-dynamic";
export const maxDuration = 10;

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ clientId: string }> }
) {
  const { clientId } = await params;
  try {
    const client = await readClient(clientId);
    if (!client) return NextResponse.json({ error: "Client not found" }, { status: 404 });

    const body = await req.json();
    const title = body.title?.trim();
    if (!title) return NextResponse.json({ error: "Title required" }, { status: 400 });
    if (title.length > 200) return NextResponse.json({ error: "Title must be under 200 characters" }, { status: 400 });

    // Limit total applications per client
    const existingApps = await listApplications(clientId);
    if (existingApps.length >= 50) {
      return NextResponse.json({ error: "Maximum 50 applications per client" }, { status: 400 });
    }

    const app = await createApplication(clientId, title);

    return NextResponse.json({ success: true, application: app });
  } catch (err) {
    console.error(`POST /api/clients/${clientId}/applications error:`, err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
