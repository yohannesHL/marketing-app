"use client";
import Link from "next/link";
import { useState } from "react";
import { connectionRequest } from "./connectionUi";
export function AccountNavigation({ signedIn, busy = false, onError }: { signedIn: boolean; busy?: boolean; onError?: (error: unknown) => void }) {
  const [signingOut, setSigningOut] = useState(false);
  async function signOut() {
    setSigningOut(true);
    try { await connectionRequest("/api/auth/session", "DELETE"); window.location.assign("/sign-in"); }
    catch (error) { onError?.(error); setSigningOut(false); }
  }
  return <nav aria-label="Account navigation" className="public-account-nav"><Link className="workspace-brand" href="/"><span className="brand-symbol">l<span>p</span></span><span>launchpad.</span></Link><div>{signedIn ? <><Link href="/dashboard" className="button">Open workspace</Link><button type="button" className="button button-quiet" disabled={busy || signingOut} onClick={signOut}>{signingOut ? "Signing out…" : "Sign out"}</button></> : <Link href="/" className="button button-quiet">Back to home</Link>}</div></nav>;
}
