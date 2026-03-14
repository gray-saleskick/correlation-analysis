import { listClients, getAggregateStats } from "@/lib/store";
import HomeClient from "./HomeClient";

export const dynamic = "force-dynamic";

export default async function HomePage() {
  const clients = await listClients();
  const stats = await getAggregateStats();
  return <HomeClient initialClients={clients} stats={stats} />;
}
