import { NextRequest, NextResponse } from "next/server";
import { getSession, deleteUser } from "@/lib/auth";

export const maxDuration = 10;

export async function POST(req: NextRequest) {
  try {
    const session = await getSession();
    if (!session) {
      return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });
    }

    const body = await req.json().catch(() => ({}));
    const { userId } = body as { userId?: string };

    if (!userId) {
      return NextResponse.json({ success: false, error: "User ID is required." }, { status: 400 });
    }

    // Prevent deleting yourself
    if (userId === session.userId) {
      return NextResponse.json({ success: false, error: "You cannot delete your own account." }, { status: 400 });
    }

    await deleteUser(userId);
    return NextResponse.json({ success: true });
  } catch (err: unknown) {
    console.error("Delete user error:", err);
    const message = err instanceof Error ? err.message : "Failed to delete user.";
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}
