import { EmailMembershipDetail } from "../../../../components/email/EmailMembershipDetail";
export default async function Page({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return <EmailMembershipDetail key={id} membershipId={id} />;
}
