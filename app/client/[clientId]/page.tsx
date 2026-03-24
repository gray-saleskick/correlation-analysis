import { notFound } from "next/navigation";
import { readProfile } from "@/lib/store";
import ClientDetailPage from "./ClientDetailPage";

export const revalidate = 10; // ISR: cache for 10 seconds

export default async function Page({ params }: { params: Promise<{ clientId: string }> }) {
  const { clientId } = await params;
  const profile = await readProfile(clientId);
  if (!profile) notFound();

  return <ClientDetailPage initialProfile={profile} />;
}
