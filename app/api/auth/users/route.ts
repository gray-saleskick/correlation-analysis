import { NextResponse } from "next/server";
import { getSession, listUsers } from "@/lib/auth";

export async function GET() {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const users = await listUsers();
  return NextResponse.json({ users });
}
