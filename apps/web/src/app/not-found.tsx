import Link from "next/link";
import { WorkspaceIcon } from "../components/workspace/WorkspaceIcon";

export default function NotFound() {
  return (
    <section className="workspace-not-found" aria-labelledby="not-found-heading">
      <Link href="/" className="workspace-brand" aria-label="Launchpad home">
        <span className="brand-symbol">l<span>p</span></span><span>launchpad.</span>
      </Link>
      <span className="eyebrow">Page not found · 404</span>
      <h1 id="not-found-heading">Let’s get you back<br />to your next idea.</h1>
      <p>This page may have moved, or the link may be incomplete. Your campaigns and content are still in your workspace.</p>
      <div className="workspace-not-found-actions">
        <Link href="/dashboard" className="button button-primary">Open your workspace <WorkspaceIcon name="arrow" /></Link>
        <Link href="/" className="button">Return to homepage</Link>
      </div>
    </section>
  );
}
