"use client";
import Link from "next/link";
import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { Alert, Button } from "@launchpad/ui";
import { PROPERTY_DEFAULTS, PROVIDER_LABELS, SOURCE_EVENTS, identityHelp, sourceLink, trackingError, trackingRequest, trackingSignIn,
  type SourceSummary, type TrackingEnvironment, type TrackingProvider } from "./trackingUi";

type EditableProvider = Exclude<TrackingProvider, "RESEND">;
type SetupResponse = { source: SourceSummary; signingSecret?: string; ingressToken?: string };
const control = "input input-bordered min-h-11 w-full bg-base-100";
const lines = (value: string) => [...new Set(value.split(/[\n,]/).map(s => s.trim()).filter(Boolean))];
export function OneTimeValue({ label, value, onDismiss }: { label: string; value: string; onDismiss: () => void }) {
  const id = useId(), [copied, setCopied] = useState(false), [error, setError] = useState(false);
  return <section className="rounded-box border border-warning p-4 space-y-3" aria-label="One-time setup value">
    <p className="font-semibold">Save this setup value now</p><p>It will not be available after leaving or dismissing this panel. Store it with your provider configuration; keep it out of logs and issue comments.</p>
    <label className="block font-medium" htmlFor={id}>{label}</label><input id={id} className={control} type="password" readOnly value={value} autoComplete="off" spellCheck={false} />
    <div className="flex flex-wrap gap-2"><Button className="min-h-11" onClick={async () => { try { await navigator.clipboard.writeText(value); setCopied(true); setError(false); } catch { setError(true); } }}>Copy setup value</Button>
      <Button className="min-h-11" variant="ghost" onClick={onDismiss}>I have saved it</Button></div>
    {copied && <p role="status">Copied. Keep your clipboard private.</p>}{error && <p role="alert">Copy is unavailable. Select the setup field and use your browser’s copy command.</p>}
  </section>;
}
export function SourceForm({ environment, source, onSaved, disabled = false, onPendingChange }: { environment: TrackingEnvironment; source?: SourceSummary; onSaved: () => Promise<void>; disabled?: boolean; onPendingChange?: (pending: boolean) => void }) {
  const [provider, setProvider] = useState<EditableProvider>((source?.provider === "RESEND" ? "API" : source?.provider) ?? "NATIVE");
  const [name, setName] = useState(source?.name ?? ""), [account, setAccount] = useState(source?.externalAccountId ?? "");
  const [origins, setOrigins] = useState(source?.config.allowedOrigins.join("\n") ?? "");
  const [events, setEvents] = useState(source?.config.allowedEvents ?? SOURCE_EVENTS[provider]);
  const [custom, setCustom] = useState("");
  const [keys, setKeys] = useState((source?.config.propertyKeys ?? PROPERTY_DEFAULTS[provider]).join("\n"));
  const [correlation, setCorrelation] = useState(source?.config.correlationField === "utm_content");
  const [replaceCredentials, setReplaceCredentials] = useState(false), [secret, setSecret] = useState(""), [apiToken, setApiToken] = useState("");
  const [busy, setBusy] = useState(false), [errors, setErrors] = useState<Record<string, string>>({}), [failure, setFailure] = useState<string | null>(null);
  const [setup, setSetup] = useState<{ label: string; value: string; source: SourceSummary } | null>(null), [saved, setSaved] = useState<SourceSummary | null>(null);
  const guard = useRef(false), summaryRef = useRef<HTMLDivElement>(null), prefix = useId();
  useEffect(() => { onPendingChange?.(busy || !!setup); return () => onPendingChange?.(false); }, [busy, setup, onPendingChange]);
  useEffect(() => { if (failure) summaryRef.current?.focus(); }, [failure]);
  if (source?.provider === "RESEND") return <p>This source is managed by its email connection. Edit sender and webhook settings in Email campaigns.</p>;
  const fieldId = (key: string) => `${prefix}-${key}`;
  const message = (key: string) => errors[key] ? <p id={`${fieldId(key)}-error`} className="text-error" role="alert">{errors[key]}</p> : null;
  function selectProvider(next: EditableProvider) { setProvider(next); setEvents(SOURCE_EVENTS[next]); setKeys(PROPERTY_DEFAULTS[next].join("\n")); setAccount(""); setOrigins(""); setCorrelation(false); setSecret(""); setApiToken(""); setErrors({}); }
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (guard.current || disabled) return;
    const invalid: Record<string, string> = {}, allowedEvents = [...new Set([...events, ...lines(custom)])], allowedOrigins = lines(origins), propertyKeys = lines(keys);
    if (!name.trim()) invalid.name = "Enter a source name.";
    if (!account.trim()) invalid.account = "Enter a stable account or source identity.";
    if (provider === "CALENDLY" && !/^https:\/\/api\.calendly\.com\/users\/[A-Za-z0-9_-]+$/.test(account)) invalid.account = "Use the complete Calendly user URI, beginning https://api.calendly.com/users/.";
    if (provider === "SHOPIFY" && !/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(account)) invalid.account = "Use the store-name.myshopify.com hostname, without a path.";
    if (provider === "NATIVE" && (!allowedOrigins.length || allowedOrigins.length > 10 || allowedOrigins.some(origin => { try { const u = new URL(origin); return u.origin !== origin || u.username || u.password || u.protocol !== "https:" && !["localhost", "127.0.0.1"].includes(u.hostname); } catch { return true; } }))) invalid.origins = "Enter 1–10 exact HTTPS site origins, without paths. Localhost development origins are also allowed.";
    if (!allowedEvents.length || allowedEvents.length > 30 || allowedEvents.some(type => !SOURCE_EVENTS[provider].includes(type) && !(provider === "API" && /^custom\.[a-z][a-z0-9_.]{0,63}$/.test(type)))) invalid.events = "Choose at least one supported event; server custom events start with custom. and use lowercase names.";
    if (propertyKeys.length > 30 || propertyKeys.some(key => !/^[a-zA-Z][a-zA-Z0-9_]{0,63}$/.test(key) || /password|secret|token|authorization/i.test(key))) invalid.keys = "Use at most 30 simple, non-secret property names, starting with a letter.";
    const credentialsNeeded = provider !== "NATIVE" && (!source || replaceCredentials);
    if (credentialsNeeded && (provider !== "API" || source || secret) && secret.length < 16) invalid.secret = "Provide the complete signing secret, at least 16 characters.";
    setErrors(invalid); setFailure(null);
    if (Object.keys(invalid).length) { requestAnimationFrame(() => summaryRef.current?.focus()); return; }
    const config = { allowedOrigins: provider === "NATIVE" ? allowedOrigins : source?.config.allowedOrigins ?? [], allowedEvents, propertyKeys,
      ...(provider === "CALENDLY" && correlation ? { correlationField: "utm_content" } : {}) };
    const credentials = credentialsNeeded ? { ...(secret ? { signingSecret: secret } : {}), ...(apiToken ? { apiToken } : {}) } : undefined;
    if (source && !credentials && JSON.stringify(config) === JSON.stringify(source.config)) { setFailure("No settings changed."); return; }
    guard.current = true; setBusy(true); setSaved(null); setSetup(null);
    try {
      const result = await trackingRequest<SetupResponse>(source ? `/api/tracking/sources/${source.id}` : "/api/tracking/sources", source ? "PATCH" : "POST",
        source ? { config, ...(credentials ? { credentials } : {}) } : { name: name.trim(), provider, environment, externalAccountId: account.trim(), config, ...(credentials ? { credentials } : {}) });
      setSecret(""); setApiToken(""); setReplaceCredentials(false); setSaved(result.source);
      if (result.signingSecret) setSetup({ label: "Server signing secret", value: result.signingSecret, source: result.source });
      else if (result.ingressToken) setSetup({ label: "Provider webhook URL", value: `${window.location.origin}/api/tracking/hooks/${result.ingressToken}`, source: result.source });
      await onSaved();
    } catch (error) { if (!trackingSignIn(error)) setFailure(trackingError(error)); }
    finally { guard.current = false; setBusy(false); }
  }
  return <div className="space-y-5">
    {setup && <OneTimeValue label={setup.label} value={setup.value} onDismiss={() => setSetup(null)} />}
    {saved && <Alert title="Source saved" tone="success" role="status">Settings were saved. <Link className="link" href={sourceLink(saved)}>Open source diagnostics</Link>. A received and matched event is still needed to demonstrate tracking.</Alert>}
    <form className="grid gap-5" onSubmit={submit} noValidate>
      {(Object.keys(errors).length > 0 || failure) && <div ref={summaryRef} tabIndex={-1} role="alert" className="rounded-box border border-error p-4 focus:outline focus:outline-2 focus:outline-primary"><h3 className="font-semibold">Check source setup</h3>{failure && <p>{failure}</p>}<ul className="list-disc pl-5">{Object.entries(errors).map(([key, value]) => <li key={key}><a className="link" href={`#${fieldId(key)}`}>{value}</a></li>)}</ul></div>}
      <fieldset disabled={busy || disabled || !!saved && !source} className="grid min-w-0 gap-5">
        {!source && <><div className="grid gap-2"><label className="font-medium" htmlFor={fieldId("provider")}>Source type</label><select id={fieldId("provider")} className="select select-bordered min-h-11 w-full bg-base-100" value={provider} onChange={e => selectProvider(e.target.value as EditableProvider)}>{Object.entries(PROVIDER_LABELS).filter(([key]) => key !== "RESEND").map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></div>
          <div className="grid gap-2"><label className="font-medium" htmlFor={fieldId("name")}>Source name</label><input id={fieldId("name")} className={control} value={name} maxLength={200} onChange={e => setName(e.target.value)} aria-invalid={!!errors.name} aria-describedby={errors.name ? `${fieldId("name")}-error` : undefined} required />{message("name")}</div></>}
        <div className="grid gap-2"><label className="font-medium" htmlFor={fieldId("account")}>{provider === "CALENDLY" ? "Calendly user URI" : provider === "SHOPIFY" ? "Shopify store hostname" : "Stable source identity"}</label><input id={fieldId("account")} className={control} value={account} maxLength={300} readOnly={!!source} onChange={e => setAccount(e.target.value)} aria-invalid={!!errors.account} aria-describedby={`${fieldId("account")}-hint${errors.account ? ` ${fieldId("account")}-error` : ""}`} required /><span id={`${fieldId("account")}-hint`} className="text-sm">{source ? "Account identity cannot be changed. Create a separate source for another account." : provider === "NATIVE" || provider === "API" ? "A stable label such as website-main or crm-production; keep it separate from the display name." : "Use the account that will sign this source’s events."}</span>{message("account")}</div>
        <p className="rounded-box bg-base-200 p-3">{identityHelp(provider)}</p>
        {provider === "NATIVE" && <div className="grid gap-2"><label className="font-medium" htmlFor={fieldId("origins")}>Allowed website origins</label><textarea id={fieldId("origins")} className="textarea textarea-bordered min-h-24 w-full bg-base-100" rows={3} value={origins} onChange={e => setOrigins(e.target.value)} placeholder="https://www.example.com" aria-invalid={!!errors.origins} aria-describedby={`${fieldId("origins")}-hint${errors.origins ? ` ${fieldId("origins")}-error` : ""}`} /><span id={`${fieldId("origins")}-hint`} className="text-sm">One exact origin per line. No wildcards or page paths.</span>{message("origins")}</div>}
        <fieldset id={fieldId("events")} aria-describedby={errors.events ? `${fieldId("events")}-error` : undefined} className="min-w-0 space-y-2" tabIndex={-1}><legend className="font-medium">Accepted event types</legend>{[...new Set([...SOURCE_EVENTS[provider], ...events])].map(type => <label key={type} className="flex min-h-11 items-center gap-3 break-all"><input className="checkbox checkbox-sm shrink-0" type="checkbox" checked={events.includes(type)} onChange={e => setEvents(previous => e.target.checked ? [...previous, type] : previous.filter(t => t !== type))} />{type}</label>)}{provider === "API" && <label className="grid gap-2"><span>Additional custom event names</span><textarea className="textarea textarea-bordered w-full bg-base-100" value={custom} onChange={e => setCustom(e.target.value)} rows={2} placeholder="custom.lead.qualified" /><span className="text-sm">One custom. event per line.</span></label>}{message("events")}</fieldset>
        <div className="grid gap-2"><label className="font-medium" htmlFor={fieldId("keys")}>Allowed property names</label><textarea id={fieldId("keys")} className="textarea textarea-bordered w-full bg-base-100" rows={4} value={keys} onChange={e => setKeys(e.target.value)} aria-invalid={!!errors.keys} aria-describedby={`${fieldId("keys")}-hint${errors.keys ? ` ${fieldId("keys")}-error` : ""}`} /><span id={`${fieldId("keys")}-hint`} className="text-sm">One name per line, up to 30. Include fields your rules need. Do not include secrets or private form responses.</span>{message("keys")}</div>
        {provider === "CALENDLY" && <label className="flex min-h-11 items-center gap-3"><input type="checkbox" className="checkbox checkbox-sm shrink-0" checked={correlation} onChange={e => setCorrelation(e.target.checked)} />Enable enquiry correlation using utm_content</label>}
        {source && provider !== "NATIVE" && <label className="flex min-h-11 items-center gap-3"><input type="checkbox" className="checkbox checkbox-sm shrink-0" checked={replaceCredentials} onChange={e => setReplaceCredentials(e.target.checked)} />Replace saved credentials</label>}
        {provider !== "NATIVE" && (!source || replaceCredentials) && <fieldset className="grid min-w-0 gap-3 rounded-box border border-base-300 p-4"><legend className="font-semibold">Signing and provider access</legend>
          {source && <p>Supply the complete replacement. Leaving the optional API token blank removes the previous token. Saved values are never displayed.</p>}
          <div className="grid gap-2"><label className="font-medium" htmlFor={fieldId("secret")}>Signing secret{provider === "API" && !source ? " (optional: generate on create)" : ""}</label><input id={fieldId("secret")} className={control} type="password" autoComplete="new-password" value={secret} onChange={e => setSecret(e.target.value)} maxLength={4096} aria-invalid={!!errors.secret} aria-describedby={errors.secret ? `${fieldId("secret")}-error` : undefined} spellCheck={false} />{message("secret")}</div>
          {(provider === "SHOPIFY" || provider === "CALENDLY") && <label className="grid gap-2"><span>Provider API token (optional, needed for read reconciliation)</span><input className={control} type="password" autoComplete="new-password" value={apiToken} onChange={e => setApiToken(e.target.value)} maxLength={4096} spellCheck={false} /></label>}
        </fieldset>}
        {source && <Alert title="Changing settings advances this source" tone="warning">Saving configuration or credentials changes its generation. Queued old evidence may need history-only replay; existing event waits retain their captured generation. This does not restart automation.</Alert>}
        <Button type="submit" loading={busy} className="min-h-11 justify-self-start">{source ? "Save source settings" : "Create source"}</Button>
      </fieldset>
    </form>
  </div>;
}
