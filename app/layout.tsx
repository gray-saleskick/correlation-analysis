import type { Metadata } from "next";
import { Suspense } from "react";
import NavigationLoader from "./components/NavigationLoader";
import AuthHeader from "./components/AuthHeader";
import { getSession } from "@/lib/auth";
import "./globals.css";

export const metadata: Metadata = {
  title: "Correlation Analysis",
  description: "Data correlation analysis tool",
};

// Server component that fetches session — streamed via Suspense
async function AuthHeaderWrapper() {
  const session = await getSession();
  return <AuthHeader email={session?.email ?? null} />;
}

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body className="min-h-screen bg-slate-950 text-slate-200 antialiased">
        <NavigationLoader>
          <Suspense fallback={<div className="h-[49px] border-b border-white/[0.08] bg-white/[0.04]" />}>
            <AuthHeaderWrapper />
          </Suspense>
          <main>{children}</main>
        </NavigationLoader>
      </body>
    </html>
  );
}
