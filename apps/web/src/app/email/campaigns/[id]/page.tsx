import { EmailCampaignEditor } from "../../../../components/email/EmailCampaignEditor";
export default async function Page({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return <EmailCampaignEditor campaignId={id} />;
}
