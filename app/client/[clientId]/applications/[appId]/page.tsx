import { cache } from "react";
import { notFound } from "next/navigation";
import { readClient, readApplicationFull } from "@/lib/db";
import { getSession } from "@/lib/auth";
import ApplicationDetail from "./ApplicationDetail";

export const dynamic = "force-dynamic";

// Deduplicate readApplicationFull calls within a single request (Page + generateMetadata)
const getCachedApp = cache((appId: string) => readApplicationFull(appId));
const getCachedClient = cache((clientId: string) => readClient(clientId));

interface PageProps {
  params: Promise<{ clientId: string; appId: string }>;
}

export default async function ApplicationDetailPage({ params }: PageProps) {
  const { clientId, appId } = await params;
  const [client, app, session] = await Promise.all([
    getCachedClient(clientId),
    getCachedApp(appId),
    getSession(),
  ]);
  if (!client || !app) notFound();

  return (
    <ApplicationDetail
      clientId={clientId}
      clientName={client.clientName}
      companyDescription={client.company_description ?? ""}
      initialApp={app}
      userEmail={session?.email}
    />
  );
}

export async function generateMetadata({ params }: { params: Promise<{ clientId: string; appId: string }> }) {
  const { appId } = await params;
  const app = await getCachedApp(appId);
  return { title: app ? `${app.title} — Correlation Analysis` : "Application — Correlation Analysis" };
}
