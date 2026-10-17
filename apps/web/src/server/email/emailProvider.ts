/** Provider-neutral delivery boundary; credentials never belong in persisted diagnostics. */

export type EmailEnvironment = "TEST" | "LIVE";
export type EmailProviderOperation = "SEND" | "RETRIEVE" | "CHECK_SENDER" | "CHECK_WEBHOOK";
export type EmailProviderCode =
  | "INVALID_REQUEST" | "MODE_DISABLED" | "PRECONDITION_FAILED"
  | "IDEMPOTENCY_EXPIRED" | "AUTHENTICATION_FAILED" | "PERMISSION_DENIED"
  | "SENDER_UNAVAILABLE" | "VALIDATION_REJECTED" | "RATE_LIMITED"
  | "IDEMPOTENCY_CONFLICT" | "REQUEST_IN_PROGRESS"
  | "NETWORK_UNCERTAIN" | "PROVIDER_UNCERTAIN" | "INVALID_PROVIDER_RESPONSE"
  | "PROVIDER_UNAVAILABLE" | "WEBHOOK_INVALID" | "PAYLOAD_TOO_LARGE";

export type EmailProviderContext = {
  environment: EmailEnvironment;
  apiKey: string;
  webhookSecret: string;
  /** Called immediately before every HTTP boundary; no provider HTTP inside its transaction. */
  beforeRequest(operation: EmailProviderOperation): Promise<void>;
};

export type OutgoingEmail = {
  from: { address: string; name?: string };
  to: string;
  replyTo?: string;
  subject: string;
  html?: string;
  text?: string;
  unsubscribeUrl: string;
  /** Random opaque local send ID. Never contact, owner, subject, or address data. */
  sendRef: string;
};

export type BuiltEmailRequest = {
  body: string;
  /** Lowercase hex SHA-256 of exact UTF-8 body bytes. */
  requestDigest: string;
};

export type FrozenEmailRequest = BuiltEmailRequest & {
  idempotencyKey: string;
  firstSubmittedAt: Date;
  idempotencyExpiresAt: Date;
};

export type EmailSendResult =
  | { kind: "ACCEPTED"; providerMessageId: string }
  /** No fetch was invoked. A committed local submission marker is still safe to close as not accepted. */
  | { kind: "NOT_SUBMITTED"; code: EmailProviderCode }
  /** Explicit recognized provider rejection. Retrying still requires current eligibility/window checks. */
  | { kind: "REJECTED"; code: EmailProviderCode; retryable: boolean; retryAfterMs?: number }
  /** Fetch was invoked and acceptance cannot be excluded. Never generate a fresh request identity. */
  | { kind: "UNKNOWN"; code: EmailProviderCode; retryAfterMs?: number };

export type RetrievedEmail = {
  providerMessageId: string;
  /** RFC email Message-ID; distinct from Resend UUID. */
  messageId?: string;
  from: string;
  to: readonly string[];
  subject: string;
  html: string | null;
  text: string | null;
  replyTo: readonly string[];
  cc: readonly string[];
  bcc: readonly string[];
  createdAt: string;
  /** Unknown future strings retained as evidence, not converted into invented delivery states. */
  lastEvent: string;
  tags: Readonly<Record<string, string>>;
};

export type EmailRetrieveResult =
  | { kind: "FOUND"; email: RetrievedEmail }
  /** Never proof of nonacceptance, even for an authenticated 404. */
  | { kind: "NOT_FOUND" }
  | { kind: "UNAVAILABLE"; code: EmailProviderCode; retryAfterMs?: number };

export type EmailSenderCheck =
  | { ready: true; domainId: string; domainName: string; status: "verified";
      sendingEnabled: true; openTracking: boolean; clickTracking: boolean; checkedAt: string }
  | { ready: false; code: EmailProviderCode; reason:
      "DOMAIN_NOT_VERIFIED" | "DOMAIN_MISMATCH" | "SENDING_DISABLED" | "READ_UNAVAILABLE";
      domainStatus?: string; checkedAt: string };

export type EmailWebhookCheck =
  | { ready: true; webhookId: string; subscribedEvents: readonly string[]; checkedAt: string }
  | { ready: false; code: EmailProviderCode; reason:
      "ENDPOINT_MISMATCH" | "SECRET_MISMATCH" | "WEBHOOK_DISABLED" | "MISSING_EVENTS" | "READ_UNAVAILABLE";
      checkedAt: string };

export type EmailEventType =
  | "email.sent" | "email.delivered" | "email.delivery_delayed"
  | "email.bounced" | "email.complained" | "email.failed"
  | "email.suppressed" | "email.opened" | "email.clicked"
  | "suppression.added" | "suppression.removed";

export type VerifiedEmailWebhook = {
  providerDeliveryId: string;
  rawPayloadDigest: string;
  /** Retains provider name, even when unsupported. */
  type: string;
  supported: boolean;
  occurredAt: string;
  providerMessageId?: string;
  messageId?: string;
  from?: string;
  to: readonly string[];
  subject?: string;
  tags: Readonly<Record<string, string>>;
  /** Email body is absent in delivery callbacks; do not assert body equality from webhook alone. */
  bounce?: { type?: string; subType?: string };
  suppressed?: { type?: string };
  suppression?: { email: string; origin: string; sourceId: string | null };
};

export type WebhookVerificationInput = {
  rawBody: Uint8Array;
  headers: Headers;
  webhookSecret: string;
  now: Date;
};

export type EmailCapabilities = {
  provider: "RESEND";
  environment: EmailEnvironment;
  send: true;
  retrieveById: true;
  senderReadiness: true;
  webhookReadiness: true;
  idempotencyWindowMs: 86400000;
  events: readonly EmailEventType[];
  remoteSequenceEnrollment: false;
  replyDetection: false;
  providerSchedulingUsed: false;
  /** Not promised in first adapter slice; known-ID retrieval is implemented. */
  unknownIdSearch: false;
};

export type EmailConnectionReadiness = {
  ready: boolean;
  checkedAt: string;
  /** Implemented adapter operations; ready=false still blocks new sends. */
  capabilities: EmailCapabilities;
  sender: EmailSenderCheck;
  webhook: EmailWebhookCheck;
};

export const EMAIL_SUPPORTED_EVENTS: readonly EmailEventType[] = Object.freeze([
  "email.sent", "email.delivered", "email.delivery_delayed", "email.bounced", "email.complained",
  "email.failed", "email.suppressed", "email.opened", "email.clicked", "suppression.added", "suppression.removed",
]);
export const EMAIL_REQUIRED_EVENTS: readonly EmailEventType[] = Object.freeze([
  "email.sent", "email.delivered", "email.delivery_delayed", "email.bounced", "email.complained",
  "email.failed", "email.suppressed", "suppression.added",
]);

export interface EmailProvider {
  readonly capabilities: EmailCapabilities;
  /** Pure: validates and serializes the exact body once, before the service encrypts/persists it. */
  buildRequest(input: OutgoingEmail): BuiltEmailRequest;
  /** Root connection service persists only this safe result; performs sender + webhook read checks. */
  validateSender(context: EmailProviderContext, input: {
    address: string;
    domainId: string;
    providerWebhookId: string;
    expectedWebhookUrlDigest: string;
  }): Promise<EmailConnectionReadiness>;
  checkSender(context: EmailProviderContext, input: { domainId: string; address: string }): Promise<EmailSenderCheck>;
  checkWebhook(context: EmailProviderContext, input: {
    webhookId: string;
    expectedUrlDigest: string;
    webhookSecret: string;
    requiredEvents: readonly EmailEventType[];
  }): Promise<EmailWebhookCheck>;
  send(context: EmailProviderContext, request: FrozenEmailRequest): Promise<EmailSendResult>;
  retrieve(context: EmailProviderContext, providerMessageId: string): Promise<EmailRetrieveResult>;
  /** Pure: throws a sanitized EmailProviderError before trusted processing if invalid. */
  verifyWebhook(input: WebhookVerificationInput): VerifiedEmailWebhook;
}

/** Resolve from the owned record environment; each returned adapter remains fixed to that mode. */
export type EmailProviderFactory = (environment: EmailEnvironment) => EmailProvider;

export class EmailProviderError extends Error {
  constructor(readonly code: EmailProviderCode, readonly status = 400) {
    super("The email provider operation could not be completed.");
    this.name = "EmailProviderError";
  }
}

export type ResendProviderConfig = {
  now?: () => Date;
  timeoutMs?: number;
  maxResponseBytes?: number;
} & (
  | { environment: "LIVE"; liveEnabled: boolean; fetch?: typeof fetch }
  | { environment: "TEST"; fixture: { origin: string; fetch: typeof fetch } }
);
