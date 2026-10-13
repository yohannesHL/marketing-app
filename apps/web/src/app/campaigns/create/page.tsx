import { CampaignCreationWizard } from "../../../components/campaign-wizard/CampaignCreationWizard";
export const dynamic = "force-dynamic";

export default function CampaignCreationPage() {
  const demoEnabled = process.env.ADS_MODE === "mock" && process.env.CONNECTION_MODE !== "live";
  return <CampaignCreationWizard demoEnabled={demoEnabled} />;
}
