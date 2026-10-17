import { PolicyPage } from "../../components/home/PolicyPage";
export default function DataDeletionPage() {
  return <PolicyPage title="Data deletion and disconnection">
    <section><h2>Disconnect a channel</h2><p>Open Integrations / channels in your workspace and disconnect the relevant authorization. This removes usable local credentials and stops its unsent work. Connection history and saved content may remain. A request already submitted to a provider cannot be recalled merely by disconnecting.</p></section>
    <section><h2>Meta deletion requests</h2><p>The app accepts signed Meta data-deletion callbacks. It revokes the matching Meta grants, removes their connection records and associated provider data, and returns a confirmation code and status URL. The status describes that connection-scoped operation, not deletion of your entire workspace, backups or posts already published on Facebook or Instagram. Other provider connections are retained.</p></section>
    <section><h2>Delete other workspace data</h2><p>Contact the operator below to request removal of your account, campaigns, uploaded media or other retained records. Include your workspace account email and the scope of the request; do not send passwords, access tokens or API keys. The operator must verify ownership and confirm what was removed, what remains and any applicable retention arrangements. Full account deletion is not currently a self-service action.</p></section>
    <section><h2>Remove published content</h2><p>Use the destination platform’s controls or an operator-assisted, explicitly authorized cleanup. Local deletion, a cancelled job or a completed Meta data-deletion receipt does not prove that published content has been removed from the platform.</p></section>
  </PolicyPage>;
}
