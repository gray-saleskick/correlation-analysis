import type { Metadata } from "next";
import Link from "next/link";
import NavigationLoader from "./components/NavigationLoader";
import "./globals.css";

export const metadata: Metadata = {
  title: "Correlation Analysis",
  description: "Data correlation analysis tool",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body className="min-h-screen bg-slate-950 text-slate-200 antialiased">
        <NavigationLoader>
          <header className="border-b border-white/[0.08] bg-white/[0.04] backdrop-blur px-6 py-3 flex items-center gap-3">
            <Link href="/" className="flex items-center gap-2.5 hover:opacity-80 transition-opacity shrink-0">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src="/logo.png" alt="SalesKick" className="h-8 w-auto rounded-lg" />
              <span className="font-semibold text-slate-300 text-sm">Correlation Analysis</span>
            </Link>
          </header>
          <main>{children}</main>
        </NavigationLoader>
      </body>
    </html>
  );
}
