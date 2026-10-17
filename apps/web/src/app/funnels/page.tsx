import { FunnelList } from "../../components/funnels/FunnelList";
export default async function Page({ searchParams }: { searchParams: Promise<{ environment?: string }> }) {
  const query = await searchParams, environment = query.environment === "LIVE" ? "LIVE" : "TEST";
  return <FunnelList key={environment} initialEnvironment={environment} />;
}
