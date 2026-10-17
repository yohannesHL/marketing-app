import Link from "next/link";
import type { ReactNode } from "react";

export function PolicyPage({ title, children }: { title: string; children: ReactNode }) {
  const email = process.env.PRIVACY_CONTACT_EMAIL;
  const contact = email && /^[^\s@?&#]+@[^\s@?&#]+\.[^\s@?&#]+$/.test(email) ? email : null;
  return <div className="marketing-site">
    <header className="marketing-header">
      <Link href="/" className="workspace-brand">launchpad.</Link>
      <nav aria-label="Policy navigation"><Link href="/privacy">Privacy</Link><Link href="/terms">Terms</Link><Link href="/data-deletion">Data deletion</Link></nav>
    </header>
    <main className="mx-auto max-w-3xl px-6 py-16 space-y-8" id="policy-content">
      <p className="eyebrow">Service information</p>
      <h1 className="text-4xl font-semibold tracking-tight">{title}</h1>
      <aside className="workspace-notice" aria-label="Policy review status">
        Policy preview. The operator must review these pages and confirm business details,
        retention arrangements, and applicable terms before public onboarding.
      </aside>
      <div className="space-y-8 [&_h2]:text-xl [&_h2]:font-semibold [&_p]:mt-3 [&_p]:leading-relaxed">{children}</div>
      <section aria-labelledby="policy-contact"><h2 id="policy-contact" className="text-xl font-semibold">Operator and contact</h2>
        <p className="mt-3">{process.env.SERVICE_OPERATOR_NAME || "Operator details have not yet been supplied for this environment."}</p>
        <p className="mt-3">{contact ? <>For privacy and deletion requests, contact <a className="text-action" href={`mailto:${contact}`}>{contact}</a>.</> : "A privacy contact has not yet been configured. In this preview environment, contact the operator who provided your workspace access."}</p>
      </section>
    </main>
  </div>;
}
