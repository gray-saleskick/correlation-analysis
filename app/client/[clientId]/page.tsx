import { notFound } from "next/navigation";
import { readProfile } from "@/lib/store";
import ClientDetailPage from "./ClientDetailPage";

export const dynamic = "force-dynamic";

export default async function Page({ params }: { params: { clientId: string } }) {
  const profile = await readProfile(params.clientId);
  if (!profile) notFound();

  return <ClientDetailPage initialProfile={profile} />;
}
