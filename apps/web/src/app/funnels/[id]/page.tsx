import { FunnelBuilder } from "../../../components/funnels/FunnelBuilder";
export default async function Page({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ view?: string; versionId?: string }> }) {
  const { id } = await params, { view, versionId } = await searchParams;
  return <FunnelBuilder key={`${id}:${view ?? "build"}:${versionId ?? ""}`} id={id} initialView={view && ["build", "results", "journeys", "activity", "simulate"].includes(view) ? view : "build"} initialReportVersionId={versionId} />;
}
