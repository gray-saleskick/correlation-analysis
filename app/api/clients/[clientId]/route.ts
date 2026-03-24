import { NextRequest, NextResponse } from "next/server";
import { readProfile, writeProfile, deleteClient } from "@/lib/store";

export const dynamic = "force-dynamic";
export const maxDuration = 10;

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ clientId: string }> }
) {
  const { clientId } = await params;
  try {
    const profile = await readProfile(clientId);
    if (!profile) return NextResponse.json({ error: "Not found" }, { status: 404 });
    return NextResponse.json({ success: true, profile });
  } catch (err) {
    console.error(`GET /api/clients/${clientId} error:`, err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}

export async function PUT(
  req: NextRequest,
  { params }: { params: Promise<{ clientId: string }> }
) {
  const { clientId } = await params;
  try {
    const profile = await readProfile(clientId);
    if (!profile) return NextResponse.json({ error: "Not found" }, { status: 404 });

    const body = await req.json();
    if (body.clientName) {
      const name = body.clientName.trim();
      if (name.length > 100) {
        return NextResponse.json({ error: "Client name must be under 100 characters" }, { status: 400 });
      }
      profile.clientName = name;
    }
    if (typeof body.company_description === "string") {
      profile.company_description = body.company_description.trim().slice(0, 2000);
    }
    await writeProfile(clientId, profile);
    return NextResponse.json({ success: true });
  } catch (err) {
    console.error(`PUT /api/clients/${clientId} error:`, err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ clientId: string }> }
) {
  const { clientId } = await params;
  try {
    const deleted = await deleteClient(clientId);
    if (!deleted) return NextResponse.json({ error: "Not found" }, { status: 404 });
    return NextResponse.json({ success: true });
  } catch (err) {
    console.error(`DELETE /api/clients/${clientId} error:`, err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
