import { listClients, getAggregateStats } from "@/lib/store";
import { getSession } from "@/lib/auth";
import HomeClient from "./HomeClient";

export const revalidate = 30; // ISR: cache for 30 seconds

export default async function HomePage() {
  const [clients, stats, session] = await Promise.all([
    listClients(),
    getAggregateStats(),
    getSession(),
  ]);
  return <HomeClient initialClients={clients} stats={stats} userEmail={session?.email} />;
}
