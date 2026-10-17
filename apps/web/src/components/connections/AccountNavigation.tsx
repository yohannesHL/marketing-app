"use client";

import Link from "next/link";
import { useState } from "react";
import { Button } from "@launchpad/ui";
import { connectionRequest } from "./connectionUi";

export function AccountNavigation({ signedIn, busy = false, onError }: {
  signedIn: boolean; busy?: boolean; onError?: (error: unknown) => void;
}) {
  const [signingOut, setSigningOut] = useState(false);
  async function signOut() {
    setSigningOut(true);
    try {
      await connectionRequest("/api/auth/session", "DELETE");
      window.location.assign("/sign-in");
    } catch (error) { onError?.(error); setSigningOut(false); }
  }
  return <nav aria-label="Account navigation" className="flex flex-wrap items-center gap-3">
    {signedIn ? <Button className="min-h-11" variant="secondary" disabled={busy} loading={signingOut} onClick={signOut}>Sign out</Button>
      : <Link prefetch={false} className="btn btn-secondary min-h-11 normal-case" href="/sign-in?returnTo=%2Fconnections">Sign in</Link>}
  </nav>;
}
