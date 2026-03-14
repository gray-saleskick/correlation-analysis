import { notFound } from "next/navigation";
import { readProfile } from "@/lib/store";
import { getSession } from "@/lib/auth";
import ApplicationDetail from "./ApplicationDetail";

export const dynamic = "force-dynamic";

interface PageProps {
  params: Promise<{ clientId: string; appId: string }>;
}

export default async function ApplicationDetailPage({ params }: PageProps) {
  const { clientId, appId } = await params;
  const [profile, session] = await Promise.all([
    readProfile(clientId),
    getSession(),
  ]);
  if (!profile) notFound();

  const app = profile.applications.find((a) => a.id === appId);
  if (!app) notFound();

  return (
    <ApplicationDetail
      clientId={clientId}
      clientName={profile.clientName}
      companyDescription={profile.company_description ?? ""}
      initialApp={app}
      userEmail={session?.email}
    />
  );
}

export async function generateMetadata({ params }: { params: Promise<{ clientId: string; appId: string }> }) {
  const { clientId, appId } = await params;
  const profile = await readProfile(clientId);
  const app = profile?.applications.find((a) => a.id === appId);
  return { title: app ? `${app.title} — Correlation Analysis` : "Application — Correlation Analysis" };
}
