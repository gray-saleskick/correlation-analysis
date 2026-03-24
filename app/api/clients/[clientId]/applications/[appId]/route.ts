import { NextRequest, NextResponse } from "next/server";
import { readProfile, writeProfile } from "@/lib/store";
import type { Application } from "@/lib/types";

export const dynamic = "force-dynamic";
export const maxDuration = 15;

// Maximum request body size (10MB) for application data
const MAX_BODY_SIZE = 10 * 1024 * 1024;

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ clientId: string; appId: string }> }
) {
  const { clientId, appId } = await params;
  try {
    const profile = await readProfile(clientId);
    if (!profile) return NextResponse.json({ error: "Client not found" }, { status: 404 });

    const app = profile.applications.find((a) => a.id === appId);
    if (!app) return NextResponse.json({ error: "Application not found" }, { status: 404 });

    return NextResponse.json({ success: true, application: app });
  } catch (err) {
    console.error(`GET app ${appId} error:`, err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}

export async function PUT(
  req: NextRequest,
  { params }: { params: Promise<{ clientId: string; appId: string }> }
) {
  const { clientId, appId } = await params;
  try {
    // Check content length
    const contentLength = parseInt(req.headers.get("content-length") ?? "0");
    if (contentLength > MAX_BODY_SIZE) {
      return NextResponse.json({ error: "Payload too large" }, { status: 413 });
    }

    const profile = await readProfile(clientId);
    if (!profile) return NextResponse.json({ error: "Client not found" }, { status: 404 });

    const body = (await req.json()) as { application: Application };
    if (!body.application) {
      return NextResponse.json({ error: "Missing application data" }, { status: 400 });
    }

    const idx = profile.applications.findIndex((a) => a.id === appId);
    if (idx < 0) {
      return NextResponse.json({ error: "Application not found" }, { status: 404 });
    }

    // Preserve the original ID and strip any sensitive fields that shouldn't be updated via PUT
    const updated = { ...body.application, id: appId };

    // Validate title length if present
    if (updated.title && updated.title.length > 200) {
      return NextResponse.json({ error: "Title must be under 200 characters" }, { status: 400 });
    }

    profile.applications[idx] = updated;
    await writeProfile(clientId, profile);

    return NextResponse.json({ success: true });
  } catch (err) {
    console.error(`PUT app ${appId} error:`, err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ clientId: string; appId: string }> }
) {
  const { clientId, appId } = await params;
  try {
    const profile = await readProfile(clientId);
    if (!profile) return NextResponse.json({ error: "Client not found" }, { status: 404 });

    const idx = profile.applications.findIndex((a) => a.id === appId);
    if (idx < 0) return NextResponse.json({ error: "Not found" }, { status: 404 });

    profile.applications.splice(idx, 1);
    await writeProfile(clientId, profile);

    return NextResponse.json({ success: true });
  } catch (err) {
    console.error(`DELETE app ${appId} error:`, err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
