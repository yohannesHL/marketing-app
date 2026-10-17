import { Suspense } from "react";
import { CampaignBuilder } from "../../../components/workspace/CampaignBuilder";
import { assistantSettings } from "../../../server/workspace/assistant";
export const dynamic = "force-dynamic";

export default function CampaignCreationPage() {
  return <Suspense fallback={<p role="status">Loading campaign builder…</p>}><CampaignBuilder assistantMode={assistantSettings().mode} aiAvailable={assistantSettings().available} /></Suspense>;
}
