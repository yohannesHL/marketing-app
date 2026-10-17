"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import type { CampaignDefinition } from "../../server/email/campaignDefinition";
export type Environment = "TEST" | "LIVE";
export type EmailSender = {
  id: string;
  connectionId: string;
  environment: Environment;
  address: string;
  name: string | null;
  replyTo: string | null;
  domainId: string | null;
  status: string;
  readiness: Record<string, unknown>;
  verifiedAt: string | null;
  refreshStatus: string;
  refreshErrorCode: string | null;
  refreshNextAttemptAt: string | null;
};
export type EmailConnection = {
  id: string;
  sourceId: string;
  name: string;
  provider: string;
  environment: Environment;
  status: string;
  generation: number;
  credentialsSaved: boolean;
  webhookConfigured: boolean;
  readiness: Record<string, unknown>;
  verifiedAt: string | null;
  senders: EmailSender[];
};
export type CampaignRevision = {
  id: string;
  number: number;
  definition: CampaignDefinition;
  publishedAt: string;
  steps: { id: string; key: string; subject: string }[];
};
export type EmailCampaign = {
  id: string;
  name: string;
  environment: Environment;
  category: string;
  membershipScope: "SUBJECT" | "CONTACT";
  status: string;
  draft: CampaignDefinition;
  draftRevision: number;
  publishedRevisionId: string | null;
  enrolmentEnabled: boolean;
  dispatchEnabled: boolean;
  revisions?: CampaignRevision[];
};
export type ContactOption = {
  id: string;
  name: string | null;
  email: string | null;
  environment?: Environment;
  createdAt?: string;
};
export type SubjectOption = {
  id: string;
  kind: string;
  contactId: string | null;
  environment: Environment;
  createdAt: string;
  contact: ContactOption | null;
};
export type EmailSource = {
  id: string;
  name: string;
  environment: Environment;
  status: string;
  provider: string;
  config: { allowedEvents: string[]; propertyKeys: string[] };
};
export type Membership = {
  id: string;
  campaignId: string;
  revisionId: string;
  scopeKind: string;
  subjectId: string | null;
  contactId: string;
  cycle: number;
  status: string;
  startedAt: string;
  endedAt: string | null;
  stopReason: string | null;
};
export type SendSummary = {
  id: string;
  stepId: string;
  status: string;
  deliveryState: string;
  dueAt: string;
  acceptedAt: string | null;
  cancelRequestedAt: string | null;
};
export type StepHistory = {
  id: string;
  stepId: string;
  status: string;
  reason: string | null;
  dueAt: string | null;
  expiresAt: string | null;
  waitStartedAt: string;
  waitDeadlineAt: string | null;
  completedAt: string | null;
  nextWakeAt: string | null;
  authorizationReason: string | null;
  sendId: string | null;
};
export type MembershipDetail = {
  membership: Membership;
  cadenceStarted: boolean;
  reasons: {
    id: string;
    kind: string;
    note: string | null;
    createdAt: string;
    endedAt: string | null;
    endReason: string | null;
    journeyId: string | null;
  }[];
  sends: SendSummary[];
  steps: StepHistory[];
};
export type Policy = {
  state: string;
  category: string;
  eligible: boolean;
  changedAt: string | null;
  holds: { category: string; reason: string }[];
};
export class EmailUiError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status = 0,
  ) {
    super(message);
  }
}
export async function emailRequest<T>(
  url: string,
  method = "GET",
  body?: unknown,
  signal?: AbortSignal,
): Promise<T> {
  let response: Response;
  try {
    response = await fetch(url, {
      method,
      credentials: "same-origin",
      cache: "no-store",
      signal,
      headers: {
        Accept: "application/json",
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") throw error;
    throw new EmailUiError(
      "NETWORK_UNAVAILABLE",
      "The request did not finish. Your edits are still here. Check your connection and try again.",
    );
  }
  const data = await response.json().catch(() => null);
  if (!response.ok)
    throw new EmailUiError(
      typeof data?.code === "string" ? data.code : "REQUEST_FAILED",
      typeof data?.message === "string"
        ? data.message
        : "The request could not be completed.",
      response.status,
    );
  return data as T;
}
export function useEmailResource<T>(url: string | null) {
  const [data, setData] = useState<T>(),
    [error, setError] = useState<Error | null>(null),
    [loading, setLoading] = useState(!!url),
    [version, setVersion] = useState(0),
    [loadedUrl, setLoadedUrl] = useState(url),
    previousUrl = useRef(url);
  useEffect(() => {
    const controller = new AbortController();
    let current = true;
    setLoadedUrl(url);
    if (previousUrl.current !== url) setData(undefined);
    previousUrl.current = url;
    setError(null);
    setLoading(!!url);
    if (url)
      emailRequest<T>(url, "GET", undefined, controller.signal)
        .then((value) => {
          if (current) setData(value);
        })
        .catch((error) => {
          if (current && error.name !== "AbortError") setError(error);
        })
        .finally(() => {
          if (current) setLoading(false);
        });
    return () => {
      current = false;
      controller.abort();
    };
  }, [url, version]);
  return {
    data: loadedUrl === url ? data : undefined,
    error: loadedUrl === url ? error : null,
    loading: loadedUrl === url ? loading : !!url,
    reload: useCallback(() => setVersion((value) => value + 1), []),
  };
}
export function useEmailAction() {
  const [busy, setBusy] = useState(false),
    [error, setError] = useState<Error | null>(null),
    [notice, setNotice] = useState<string | null>(null),
    lock = useRef(false),
    mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const run = useCallback(
    async <T>(
      operation: () => Promise<T>,
      success?: string,
    ): Promise<T | undefined> => {
      if (lock.current) return;
      lock.current = true;
      setBusy(true);
      setError(null);
      setNotice(null);
      try {
        const value = await operation();
        if (!mounted.current) return undefined;
        if (success) setNotice(success);
        return value;
      } catch (error) {
        if (mounted.current)
          setError(
            error instanceof Error
              ? error
              : new Error("The request could not be completed."),
          );
        return undefined;
      } finally {
        lock.current = false;
        if (mounted.current) setBusy(false);
      }
    },
    [],
  );
  return { busy, error, notice, run, setError, setNotice };
}
export function useDirtyGuard(dirty: boolean) {
  useEffect(() => {
    if (!dirty) return;
    const before = (event: BeforeUnloadEvent) => {
      event.preventDefault();
    };
    window.addEventListener("beforeunload", before);
    return () => window.removeEventListener("beforeunload", before);
  }, [dirty]);
}
export const dateLabel = (value: string | null | undefined) =>
  value ? new Date(value).toLocaleString() : "—";
export const recipientLabel = (value: ContactOption) =>
  `${value.name || value.email || "Unnamed recipient"}${value.name && value.email ? ` · ${value.email}` : ""}`;
export const shortId = (id: string) => id.slice(0, 8);
export const newKey = () => crypto.randomUUID();
export function defaultDefinition(senderId = ""): CampaignDefinition {
  return {
    schemaVersion: 1,
    senderId,
    subscriptionCategory: "updates",
    timeZone: "UTC",
    sendWindow: {
      timeZone: "UTC",
      weekdays: [1, 2, 3, 4, 5],
      startMinute: 540,
      endMinute: 1020,
    },
    steps: [
      {
        id: newKey(),
        subject: "",
        text: "",
        wait: { kind: "IMMEDIATE" },
        expiresAfterDueSeconds: 604800,
      },
    ],
  };
}
export function useCommandKey() {
  const ref = useRef<{ payload: string; key: string } | null>(null);
  return {
    keyFor: (value: unknown) => {
      const payload = JSON.stringify(value);
      if (ref.current?.payload !== payload)
        ref.current = { payload, key: newKey() };
      return ref.current.key;
    },
    reset: () => {
      ref.current = null;
    },
  };
}
