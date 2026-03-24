import { NextRequest, NextResponse } from "next/server";
import { readClient, updateClient, deleteClient, listApplications, readApplicationFull } from "@/lib/db";
import type { ClientProfile } from "@/lib/types";

export const dynamic = "force-dynamic";
export const maxDuration = 10;

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ clientId: string }> }
) {
  const { clientId } = await params;
  try {
    const client = await readClient(clientId);
    if (!client) return NextResponse.json({ error: "Not found" }, { status: 404 });

    // Build the ClientProfile shape that existing consumers expect
    const apps = await listApplications(clientId);
    const profile: ClientProfile = {
      clientId: client.clientId,
      clientName: client.clientName,
      company_description: client.company_description,
      created_at: client.created_at,
      updated_at: client.created_at,
      applications: apps.map((a) => ({
        id: a.id,
        title: a.title,
        source: a.source as "manual",
        added_at: a.added_at,
        questions: [],
      })),
    };

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
    const client = await readClient(clientId);
    if (!client) return NextResponse.json({ error: "Not found" }, { status: 404 });

    const body = await req.json();
    const updates: { client_name?: string; company_description?: string } = {};

    if (body.clientName) {
      const name = body.clientName.trim();
      if (name.length > 100) {
        return NextResponse.json({ error: "Client name must be under 100 characters" }, { status: 400 });
      }
      updates.client_name = name;
    }
    if (typeof body.company_description === "string") {
      updates.company_description = body.company_description.trim().slice(0, 2000);
    }

    if (Object.keys(updates).length > 0) {
      await updateClient(clientId, updates);
    }

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
