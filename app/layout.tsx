import type { Metadata } from "next";
import NavigationLoader from "./components/NavigationLoader";
import AuthHeader from "./components/AuthHeader";
import { getSession } from "@/lib/auth";
import "./globals.css";

export const metadata: Metadata = {
  title: "Correlation Analysis",
  description: "Data correlation analysis tool",
};

export default async function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const session = await getSession();

  return (
    <html lang="en">
      <body className="min-h-screen bg-slate-950 text-slate-200 antialiased">
        <NavigationLoader>
          <AuthHeader email={session?.email ?? null} />
          <main>{children}</main>
        </NavigationLoader>
      </body>
    </html>
  );
}
