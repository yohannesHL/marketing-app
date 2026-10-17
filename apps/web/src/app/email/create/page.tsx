import { EmailCampaignEditor } from "../../../components/email/EmailCampaignEditor";
export default async function Page({
  searchParams,
}: {
  searchParams: Promise<{ environment?: string }>;
}) {
  const query = await searchParams;
  return (
    <EmailCampaignEditor
      environment={query.environment === "LIVE" ? "LIVE" : "TEST"}
    />
  );
}
