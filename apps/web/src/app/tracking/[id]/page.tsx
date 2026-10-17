import { TrackingSourceDetail } from "../../../components/tracking/TrackingSourceDetail";
export default async function TrackingSourcePage({ params, searchParams }: {
  params: Promise<{ id: string }>; searchParams: Promise<{ environment?: string | string[]; event?: string | string[] }>;
}) {
  const [{ id }, query] = await Promise.all([params, searchParams]);
  return <TrackingSourceDetail sourceId={id} expectedEnvironment={typeof query.environment === "string" ? query.environment : undefined}
    requestedEvent={typeof query.event === "string" ? query.event : undefined} />;
}
