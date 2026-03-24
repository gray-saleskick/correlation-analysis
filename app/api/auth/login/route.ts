import { NextRequest, NextResponse } from "next/server";
import { getUserByEmail, verifyPassword, needsRehash, hashPassword, signToken, buildSessionCookie, updatePasswordHash } from "@/lib/auth";

export const maxDuration = 10;

export async function POST(req: NextRequest) {
  const t0 = Date.now();
  try {
    const body = await req.json().catch(() => ({}));
    const { email, password } = body as { email?: string; password?: string };

    if (!email || !password) {
      return NextResponse.json({ success: false, error: "Email and password are required." }, { status: 400 });
    }

    // Dev mode: skip Supabase + bcrypt entirely for instant login
    if (process.env.NODE_ENV === "development" && process.env.DEV_BYPASS_AUTH === "true") {
      console.log(`[login] DEV BYPASS for ${email}`);
      const token = await signToken({ userId: "dev-user", email });
      const res = NextResponse.json({ success: true, email, name: "Dev User" });
      res.headers.set("Set-Cookie", buildSessionCookie(token));
      return res;
    }

    const t1 = Date.now();
    const user = await getUserByEmail(email);
    const t2 = Date.now();
    console.log(`[login] Supabase lookup: ${t2 - t1}ms`);

    if (!user) {
      return NextResponse.json({ success: false, error: "Invalid email or password." }, { status: 401 });
    }

    const valid = await verifyPassword(password, user.password_hash);
    const t3 = Date.now();
    console.log(`[login] bcrypt.compare: ${t3 - t2}ms (rounds: ${user.password_hash.substring(4, 6)})`);

    if (!valid) {
      return NextResponse.json({ success: false, error: "Invalid email or password." }, { status: 401 });
    }

    const token = await signToken({ userId: user.id, email: user.email });
    const t4 = Date.now();
    console.log(`[login] JWT sign: ${t4 - t3}ms | total: ${t4 - t0}ms`);

    const res = NextResponse.json({ success: true, email: user.email, name: user.name });
    res.headers.set("Set-Cookie", buildSessionCookie(token));

    // Rehash in background if stored hash uses more expensive rounds
    if (needsRehash(user.password_hash)) {
      console.log(`[login] Scheduling background rehash (${user.password_hash.substring(4, 6)} → 10 rounds)`);
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
