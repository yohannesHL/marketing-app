import { EmailCampaignList } from "../../components/email/EmailCampaignList";
export default async function Page({
  searchParams,
}: {
  searchParams: Promise<{ environment?: string }>;
}) {
  const query = await searchParams;
  return (
    <EmailCampaignList
      key={query.environment === "LIVE" ? "LIVE" : "TEST"}
      environment={query.environment === "LIVE" ? "LIVE" : "TEST"}
    />
  );
}
