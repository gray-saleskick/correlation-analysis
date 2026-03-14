import { NextRequest, NextResponse } from "next/server";
import { getSession, getUserByEmail, verifyPassword, updatePassword } from "@/lib/auth";

export async function POST(req: NextRequest) {
  try {
    const session = await getSession();
    if (!session) {
      return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });
    }

    const body = await req.json().catch(() => ({}));
    const { currentPassword, newPassword } = body as { currentPassword?: string; newPassword?: string };

    if (!currentPassword || !newPassword) {
      return NextResponse.json({ success: false, error: "Current and new passwords are required." }, { status: 400 });
    }

    if (newPassword.length < 6) {
      return NextResponse.json({ success: false, error: "New password must be at least 6 characters." }, { status: 400 });
    }

    const user = await getUserByEmail(session.email);
    if (!user) {
      return NextResponse.json({ success: false, error: "User not found." }, { status: 404 });
    }

    const valid = await verifyPassword(currentPassword, user.password_hash);
    if (!valid) {
      return NextResponse.json({ success: false, error: "Current password is incorrect." }, { status: 401 });
    }

    await updatePassword(user.id, newPassword);
    return NextResponse.json({ success: true });
  } catch (err) {
    console.error("Change password error:", err);
    return NextResponse.json({ success: false, error: "Failed to change password." }, { status: 500 });
  }
}
