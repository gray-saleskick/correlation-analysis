"use client";

import { useRouter, usePathname } from "next/navigation";
import Link from "next/link";

export default function AuthHeader({ email }: { email: string | null }) {
  const router = useRouter();
  const pathname = usePathname();

  // Don't show header on login or share pages
  if (pathname.startsWith("/login") || pathname.startsWith("/share/")) {
    return null;
  }

  async function handleLogout() {
    await fetch("/api/auth/logout", { method: "POST" });
    router.push("/login");
    router.refresh();
  }

  return (
    <header className="border-b border-white/[0.08] bg-white/[0.04] backdrop-blur px-6 py-3 flex items-center gap-3">
      <Link href="/" className="flex items-center gap-2.5 hover:opacity-80 transition-opacity shrink-0">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src="/logo.png" alt="SalesKick" className="h-8 w-auto rounded-lg" />
        <span className="font-semibold text-slate-300 text-sm">Correlation Analysis</span>
      </Link>

      {email && (
        <div className="ml-auto flex items-center gap-3">
          <span className="text-[11px] text-slate-400">{email}</span>
          <button
            onClick={handleLogout}
            className="text-[11px] font-medium text-slate-400 hover:text-red-400 transition-colors px-2 py-1 rounded hover:bg-white/[0.04]"
          >
            Sign Out
          </button>
        </div>
      )}
    </header>
  );
}
