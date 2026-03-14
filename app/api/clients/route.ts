import { NextRequest, NextResponse } from "next/server";
import { listClients, createClient } from "@/lib/store";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const clients = await listClients();
    return NextResponse.json({ success: true, clients });
  } catch (err) {
    console.error("GET /api/clients error:", err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  try {
    // Validate content type
    const contentType = req.headers.get("content-type");
    if (!contentType?.includes("application/json")) {
      return NextResponse.json({ error: "Content-Type must be application/json" }, { status: 415 });
    }

    const body = await req.json();
    const clientName = body.clientName?.trim();

    if (!clientName) {
      return NextResponse.json({ error: "Client name required" }, { status: 400 });
    }
    if (clientName.length > 100) {
      return NextResponse.json({ error: "Client name must be under 100 characters" }, { status: 400 });
    }

    const profile = await createClient(clientName);
    return NextResponse.json({ success: true, client: profile });
  } catch (err) {
    console.error("POST /api/clients error:", err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
