import { CampaignDetail } from "../../../components/workspace/CampaignDetail";
export const metadata = { title: "Campaign overview · Launchpad" };
export default async function Page({params}:{params:Promise<{id:string}>}) { const {id}=await params; return <CampaignDetail id={id}/>; }
