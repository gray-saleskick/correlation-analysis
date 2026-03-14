import { NextRequest, NextResponse } from "next/server";
import { getSession, resetUserPassword } from "@/lib/auth";

export async function POST(req: NextRequest) {
  try {
    const session = await getSession();
    if (!session) {
      return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });
    }

    const body = await req.json().catch(() => ({}));
    const { userId, newPassword } = body as { userId?: string; newPassword?: string };

    if (!userId || !newPassword) {
      return NextResponse.json({ success: false, error: "User ID and new password are required." }, { status: 400 });
    }

    if (newPassword.length < 6) {
      return NextResponse.json({ success: false, error: "Password must be at least 6 characters." }, { status: 400 });
    }

    await resetUserPassword(userId, newPassword);
    return NextResponse.json({ success: true });
  } catch (err: unknown) {
    console.error("Reset password error:", err);
    const message = err instanceof Error ? err.message : "Failed to reset password.";
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}
