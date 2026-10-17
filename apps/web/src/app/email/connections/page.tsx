import { EmailConnections } from "../../../components/email/EmailConnections";
export default async function Page({
  searchParams,
}: {
  searchParams: Promise<{ environment?: string }>;
}) {
  const query = await searchParams;
  return (
    <EmailConnections
      key={query.environment}
      environment={query.environment === "LIVE" ? "LIVE" : "TEST"}
    />
  );
}
