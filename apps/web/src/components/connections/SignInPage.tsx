"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { Alert, Button, Card, Container, Input, Stack, Typography } from "@launchpad/ui";
import { AccountNavigation } from "./AccountNavigation";
import { connectionRequest, ConnectionUiError, safeReturnTo } from "./connectionUi";

export function SignInPage() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [signedIn, setSignedIn] = useState(false);
  const errorRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    let active = true;
    connectionRequest("/api/auth/session").then(() => { if (active) setSignedIn(true); }).catch(() => {});
    return () => { active = false; };
  }, []);
  useEffect(() => { if (error) errorRef.current?.focus(); }, [error]);
  const returnTo = () => safeReturnTo(new URLSearchParams(window.location.search).get("returnTo") ?? "/dashboard");
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setBusy(true); setError(null);
    try {
      await connectionRequest("/api/auth/login", "POST", { email, password });
      setPassword(""); window.location.assign(returnTo());
    } catch (failure) {
      setError(failure instanceof ConnectionUiError ? failure.message : "Sign-in could not be completed. Try again shortly.");
      setBusy(false);
    }
  }
  return <main className="sign-in-page" data-testid="sign-in-page"><Container><Stack gap={8}>
    <AccountNavigation signedIn={signedIn} busy={busy} onError={(failure) => setError(failure instanceof Error ? failure.message : "Sign-out failed. Try again.")} />
    <div className="mx-auto w-full max-w-lg"><Stack gap={6}>
      <div><Typography as="span" variant="overline">Your Launchpad workspace</Typography>
        <Typography as="h1" variant="heading-1">Sign in</Typography>
        <Typography tone="muted">Manage your advertising accounts and publishing permissions securely.</Typography></div>
      {error ? <div ref={errorRef} tabIndex={-1} className="rounded-box focus:outline focus:outline-2 focus:outline-primary"><Alert tone="danger" title="Unable to continue">{error}</Alert></div> : null}
      {signedIn ? <Card><Typography>You’re already signed in.</Typography><Button onClick={() => window.location.assign(returnTo())}>Continue to workspace</Button></Card>
        : <Card><form onSubmit={submit} aria-busy={busy}><Stack gap={5}>
          <Input className="focus-within:ring-2 focus-within:ring-primary" label="Email" name="email" type="email" autoComplete="username" required value={email} disabled={busy} onChange={(event) => setEmail(event.target.value)} />
          <Input className="focus-within:ring-2 focus-within:ring-primary" label="Password" name="password" type="password" autoComplete="current-password" required value={password} disabled={busy} onChange={(event) => setPassword(event.target.value)} />
          <Button type="submit" loading={busy} className="w-full min-h-12">{busy ? "Signing in…" : "Sign in"}</Button>
          <Typography tone="muted">Use the account provided by your workspace administrator.</Typography>
        </Stack></form></Card>}
    </Stack></div>
  </Stack></Container></main>;
}
