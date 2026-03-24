import { notFound } from "next/navigation";
import { readClient, listApplications } from "@/lib/db";
import type { ClientProfile } from "@/lib/types";
import ClientDetailPage from "./ClientDetailPage";

export const revalidate = 10; // ISR: cache for 10 seconds

export default async function Page({ params }: { params: Promise<{ clientId: string }> }) {
  const { clientId } = await params;
  const client = await readClient(clientId);
  if (!client) notFound();

  const apps = await listApplications(clientId);

  // Build ClientProfile shape that ClientDetailPage expects
  const profile: ClientProfile = {
    clientId: client.clientId,
    clientName: client.clientName,
    company_description: client.company_description,
    created_at: client.created_at,
    updated_at: client.created_at, // No separate updated_at from readClient
    applications: apps.map((a) => ({
      id: a.id,
      title: a.title,
      source: a.source as "manual",
      added_at: a.added_at,
      questions: [],
    })),
  };

  return <ClientDetailPage initialProfile={profile} />;
}
