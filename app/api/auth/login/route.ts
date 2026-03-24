import { NextRequest, NextResponse } from "next/server";
import { getUserByEmail, verifyPassword, needsRehash, hashPassword, signToken, buildSessionCookie, updatePasswordHash } from "@/lib/auth";

export const maxDuration = 10;

export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({}));
    const { email, password } = body as { email?: string; password?: string };

    if (!email || !password) {
      return NextResponse.json({ success: false, error: "Email and password are required." }, { status: 400 });
    }

    const user = await getUserByEmail(email);
    if (!user) {
      return NextResponse.json({ success: false, error: "Invalid email or password." }, { status: 401 });
    }

    const valid = await verifyPassword(password, user.password_hash);
    if (!valid) {
      return NextResponse.json({ success: false, error: "Invalid email or password." }, { status: 401 });
    }

    const token = await signToken({ userId: user.id, email: user.email });
    const res = NextResponse.json({ success: true, email: user.email, name: user.name });
    res.headers.set("Set-Cookie", buildSessionCookie(token));

    // Rehash in background if stored hash uses more expensive rounds
    if (needsRehash(user.password_hash)) {
      hashPassword(password).then(newHash =>
        updatePasswordHash(user.id, newHash).catch(() => {})
      );
    }

    return res;
  } catch (err) {
    console.error("Login error:", err);
    return NextResponse.json({ success: false, error: "Login failed." }, { status: 500 });
  }
}
