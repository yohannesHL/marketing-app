import { PolicyPage } from "../../components/home/PolicyPage";
export default function TermsPage() {
  return <PolicyPage title="Service terms preview">
    <section><h2>Authorized accounts and content</h2><p>Use accounts and media you are authorized to manage. Review generated copy, factual claims, rights, destination, visibility and timing before approving publication. AI output and platform acceptance do not establish accuracy, content ownership or permission to publish.</p></section>
    <section><h2>Approval and delivery</h2><p>Approval applies to the saved revision and destinations. Content changes require a new review. Scheduled delivery runs in the background and depends on current authorization, media availability, quotas and provider processing. Scheduling does not guarantee an exact publication time, audience reach or performance.</p></section>
    <section><h2>Advertising and provider costs</h2><p>Social publishing and paid advertising use separate permissions and workflows. Connecting or checking an account does not start advertising. Customers retain their provider accounts and advertising billing. Provider API charges may apply independently of advertising spend; any displayed allocation ceiling is not the provider’s final bill.</p></section>
    <section><h2>Cancellation and service configuration</h2><p>You can cancel eligible pending work or disconnect a channel. Content already submitted may still be processed by its provider; a local cancellation does not remove an already published post. Features depend on the operator’s configuration and provider access. Commercial terms and deployment-specific policies still require operator review before public use.</p></section>
  </PolicyPage>;
}
