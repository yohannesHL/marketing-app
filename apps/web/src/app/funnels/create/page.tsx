import { FunnelCreate } from "../../../components/funnels/FunnelCreate";
export default async function Page({ searchParams }: { searchParams: Promise<{ environment?: string }> }) {
  return <FunnelCreate initialEnvironment={(await searchParams).environment === "LIVE" ? "LIVE" : "TEST"} />;
}
