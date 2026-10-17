import { FunnelBuilder } from "../../../components/funnels/FunnelBuilder";
export default async function Page({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ view?: string }> }) {
  const { id } = await params, { view } = await searchParams;
  return <FunnelBuilder key={id} id={id} initialView={view && ["build", "journeys", "activity", "simulate"].includes(view) ? view : "build"} />;
}
