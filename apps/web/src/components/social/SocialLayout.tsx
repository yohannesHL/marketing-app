"use client";
import Link from "next/link";
import { useEffect, useRef, type ReactNode } from "react";
import { usePathname } from "next/navigation";
import { Alert, Container, Stack, Typography } from "@launchpad/ui";
import { useWorkspaceNavigationGuard } from "../workspace/AppShell";
export function SocialLayout({
  embedded = false,
  title,
  description,
  mode,
  loading = false,
  busy = false,
  error,
  notice,
  onError,
  onNavigate,
  children,
}: {
  embedded?: boolean;
  title: string;
  description: string;
  mode?: string;
  loading?: boolean;
  busy?: boolean;
  error?: string | null;
  notice?: string | null;
  onError?: (error: unknown) => void;
  onNavigate?: (href: string) => void;
  children: ReactNode;
}) {
  useWorkspaceNavigationGuard(onNavigate);
  const pathname = usePathname();
  const errorRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (error) errorRef.current?.focus();
  }, [error]);
  return (
    <section
      className={embedded ? "social-workspace social-workspace-embedded" : "workspace-page social-workspace"}
      data-testid="social-page"
      onClickCapture={(event) => {
        if (
          !onNavigate ||
          event.defaultPrevented ||
          event.ctrlKey ||
          event.metaKey ||
          event.shiftKey ||
          event.altKey
        )
          return;
        const link = (event.target as HTMLElement).closest("a");
        const href = link?.getAttribute("href");
        if (href?.startsWith("/") && !href.startsWith("//") && !link?.target) {
          event.preventDefault();
          onNavigate(href);
        }
      }}
    >
      <Container>
        <Stack gap={6}>
          <nav
            aria-label="Social publishing navigation"
            className="module-tabs"
          >
            <Link
              href="/social"
              aria-current={pathname === "/social" ? "page" : undefined}
            >
              Publishing calendar
            </Link>
            <Link
              href="/social/create"
              aria-current={pathname === "/social/create" ? "page" : undefined}
            >
              Create social post
            </Link>
            <Link
              href="/connections"
              className="module-tab-settings"
            >
              Social connections
            </Link>
          </nav>
          <div>
            <span className="eyebrow">Social marketing</span>
            <Typography as={embedded ? "h2" : "h1"} variant={embedded ? "heading-2" : "heading-1"} className="mt-2">
              {title}
            </Typography>
            <Typography tone="muted" className="mt-2 max-w-3xl">
              {description}
            </Typography>
          </div>
          {mode ? (
            <Alert
              tone={mode === "mock" ? "warning" : "info"}
              role="note"
              title={
                mode === "mock" ? "Mockoon test mode" : "Live provider mode"
              }
            >
              {mode === "mock"
                ? "These drafts use test connections. Mock outcomes do not validate live publishing or provider approval."
                : "Publishing requires an approved social connection and an explicitly enabled provider."}{" "}
              Advertising authorizations are separate.
            </Alert>
          ) : null}
          {error ? (
            <div
              tabIndex={-1}
              ref={errorRef}
              className="rounded-box focus:outline focus:outline-2 focus:outline-primary"
            >
              <Alert title="Post needs attention" tone="danger">
                {error}
              </Alert>
            </div>
          ) : null}
          {notice ? (
            <Alert title="Post update" tone="success" role="status">
              {notice}
            </Alert>
          ) : null}
          {loading ? (
            <Typography role="status">
              Loading your social workspace…
            </Typography>
          ) : (
            children
          )}
          {busy ? (
            <div role="status" aria-live="polite">
              Updating your post… Please wait.
            </div>
          ) : null}
        </Stack>
      </Container>
    </section>
  );
}
