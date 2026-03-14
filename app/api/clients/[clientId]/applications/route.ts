import { NextRequest, NextResponse } from "next/server";
import { readProfile, writeProfile, uid } from "@/lib/store";
import type { Application } from "@/lib/types";

export const dynamic = "force-dynamic";

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ clientId: string }> }
) {
  const { clientId } = await params;
  try {
    const profile = await readProfile(clientId);
    if (!profile) return NextResponse.json({ error: "Client not found" }, { status: 404 });

    const body = await req.json();
    const title = body.title?.trim();
    if (!title) return NextResponse.json({ error: "Title required" }, { status: 400 });
    if (title.length > 200) return NextResponse.json({ error: "Title must be under 200 characters" }, { status: 400 });

    // Limit total applications per client
    if (profile.applications.length >= 50) {
      return NextResponse.json({ error: "Maximum 50 applications per client" }, { status: 400 });
    }

    const app: Application = {
      id: uid(),
      title,
      source: "manual",
      added_at: new Date().toISOString(),
      questions: [],
      submissions: [],
      bookings: [],
      financial_records: [],
      call_results: [],
    };

    profile.applications.push(app);
    await writeProfile(clientId, profile);

    return NextResponse.json({ success: true, application: app });
  } catch (err) {
    console.error(`POST /api/clients/${clientId}/applications error:`, err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
