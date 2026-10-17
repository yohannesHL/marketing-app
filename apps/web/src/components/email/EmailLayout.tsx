"use client";
import { useAppNavigationEnvironment, useAppNavigationGuard } from "../workspace/AppShell";
import Link from "next/link";
import { useEffect, useId, useRef, type ReactNode } from "react";
import { Container } from "@launchpad/ui";
import { EmailUiError, type Environment } from "./emailUi";
export const inputClass =
  "input input-bordered min-h-11 min-w-0 w-full bg-base-100";
export const selectClass =
  "select select-bordered min-h-11 min-w-0 w-full bg-base-100";
export const buttonClass =
  "btn btn-secondary min-h-11 h-auto whitespace-normal normal-case";
export function EmailField({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: (id: string) => ReactNode;
}) {
  const id = useId();
  return (
    <div className="min-w-0">
      <label className="mb-2 block font-medium" htmlFor={id}>
        {label}
      </label>
      {children(id)}
      {hint ? (
        <p className="mt-2 text-sm text-base-content/75">{hint}</p>
      ) : null}
    </div>
  );
}
export function EmailPanel({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}) {
  return (
    <section className="min-w-0 rounded-box border border-base-300 bg-base-100 p-4 sm:p-6">
      <h2 className="mb-4 text-xl font-semibold">{title}</h2>
      {children}
    </section>
  );
}
export function EmailFeedback({
  error,
  notice,
  busy,
}: {
  error?: Error | null;
  notice?: string | null;
  busy?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (error) ref.current?.focus();
  }, [error]);
  return (
    <>
      {error ? (
        <div
          ref={ref}
          tabIndex={-1}
          role="alert"
          className="rounded-box border border-error p-4 focus:outline focus:outline-2 focus:outline-error"
        >
          <p className="font-semibold">This needs attention</p>
          <p>{error.message}</p>
          {error instanceof EmailUiError && error.code === "DRAFT_CHANGED" ? (
            <p className="mt-2">
              Your local edits are preserved. Reload the saved version only when
              you are ready to replace them.
            </p>
          ) : null}
          {error instanceof EmailUiError && error.status === 401 ? (
            <Link
              className="link mt-2 inline-block"
              href={`/sign-in?returnTo=${encodeURIComponent(typeof window !== "undefined" ? window.location.pathname : "/email")}`}
            >
              Sign in to continue
            </Link>
          ) : null}
        </div>
      ) : null}
      {notice ? (
        <p role="status" className="rounded-box border border-success p-4">
          {notice}
        </p>
      ) : null}
      {busy ? (
        <p role="status" aria-live="polite">
          Saving your update…
        </p>
      ) : null}
    </>
  );
}
export function EmailLayout({
  title,
  description,
  environment,
  children,
  dirty = false,
}: {
  title: string;
  description: string;
  environment?: Environment;
  children: ReactNode;
  dirty?: boolean;
}) {
  useAppNavigationEnvironment(environment);
  useAppNavigationGuard(() => !dirty || window.confirm("Leave this page and discard unsaved campaign edits?"));
  return (
      <section className="workspace-page">
        <Container>
          <div className="space-y-6">
            <nav aria-label="Email workspace" className="flex flex-wrap gap-3">
              <Link
                className={buttonClass}
                href={`/email${environment ? `?environment=${environment}` : ""}`}
              >
                Email campaigns
              </Link>
              <Link
                className={buttonClass}
                href={`/email/connections${environment ? `?environment=${environment}` : ""}`}
              >
                Email connections
              </Link>
              <Link
                className="btn btn-ghost min-h-11 normal-case"
                href={`/funnels${environment ? `?environment=${environment}` : ""}`}
              >
                Funnels
              </Link>
            </nav>
            <header>
              <p className="mb-2 text-sm font-semibold uppercase tracking-wide">
                Email marketing{environment ? ` · ${environment}` : ""}
              </p>
              <h1 className="text-3xl font-semibold tracking-tight sm:text-4xl">
                {title}
              </h1>
              <p className="mt-3 max-w-3xl text-base-content/75">
                {description}
              </p>
            </header>
            {environment ? (
              <p role="note" className="rounded-box bg-base-200 p-4">
                {environment === "TEST"
                  ? "TEST uses a separately configured local provider fixture. It does not send production email. Simulation works without a provider connection."
                  : "LIVE campaigns can send real email when delivery and an authorized sequence are enabled. Existing runs keep their published version."}
              </p>
            ) : null}
            {children}
          </div>
        </Container>
      </section>
  );
}
export function EnvironmentPicker({
  value,
  onChange,
  disabled = false,
}: {
  value: Environment;
  onChange: (v: Environment) => void;
  disabled?: boolean;
}) {
  return (
    <div className="max-w-xs">
      <EmailField label="Environment">
        {(id) => (
          <select
            id={id}
            value={value}
            onChange={(e) => onChange(e.target.value as Environment)}
            disabled={disabled}
            className={selectClass}
          >
            <option value="TEST">TEST · local fixture</option>
            <option value="LIVE">LIVE · real recipients</option>
          </select>
        )}
      </EmailField>
    </div>
  );
}
