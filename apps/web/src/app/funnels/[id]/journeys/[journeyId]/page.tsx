import { FunnelBuilder } from "../../../../../components/funnels/FunnelBuilder";
export default async function Page({ params }: { params: Promise<{ id: string; journeyId: string }> }) {
  const { id, journeyId } = await params; return <FunnelBuilder key={`${id}:${journeyId}`} id={id} initialJourneyId={journeyId} initialView="activity" />;
}
