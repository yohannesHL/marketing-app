import { fail } from "../security/errors";
import type { Platform, DestinationKind, SocialMediaAsset, SocialDeliveryPhase } from "../../generated/prisma/client";
import type { ProviderGrant } from "../connections/customerConnections";

export type SocialMode = "mock" | "live";
export type SocialFormat = "TEXT" | "IMAGE" | "SHORT_VIDEO";
export type SocialVariantInput = { destinationId: string; format: SocialFormat; title?: string; body?: string; mediaIds?: string[]; providerOptions?: Record<string, unknown> };
export type SocialDraftInput = { title: string; body: string; mediaIds: string[]; variants: SocialVariantInput[] };
export type SocialScheduleInput = { revisionId: string; destinationIds: string[]; enqueueId: string; dueAt: string; timeZone: string };
export type SocialProgress = Record<string, unknown>;
export type SocialMediaResolver = (request: {
  ownerId: string; deliveryId: string; revisionId: string;
  media: ReadonlyArray<SocialMediaAsset>; minimumValidUntil: Date;
}) => Promise<ReadonlyArray<{ id: string; url: string }>>;

/** Credentials and ephemeral media URLs exist only inside the checked RPC callback. */
export type SocialProviderCall = {
  mode: SocialMode; accessToken: string; refreshToken?: string;
  authorizationId?: string;
  providerUserId?: string;
  authorizationGeneration?: number;
  authorizeApiCost?(input: { operation: string; costMicros: number; maxApiCostMicros: number }): Promise<void>;
  /** SDK methods that perform multiple requests must guard every HTTP boundary. */
  verifyCurrent(): Promise<void>;
  destination: { externalId: string; kind: DestinationKind; metadata: unknown };
  media: ReadonlyArray<{ id: string; url: string; mime: string; bytes: number; width: number; height: number; durationMs: number | null; metadata?: Record<string, string | number> }>;
};
export type SocialProviderContext = {
  deliveryId: string; revisionId: string;
  content: Readonly<{ title: string; body: string; format: SocialFormat; providerOptions: Readonly<Record<string, unknown>> }>;
  rpc<T>(phase: Exclude<SocialDeliveryPhase, "COMPLETE">, invoke: (context: SocialProviderCall) => Promise<T>): Promise<T>;
  checkpoint(progress: SocialProgress): Promise<void>;
};
export type SocialPublished = { externalId: string; publishUrl?: string };
export type SocialStatusResult =
  | { status: "PUBLISHED"; result: SocialPublished }
  /** A verified known receipt failed processing; retaining it prevents another create. */
  | { status: "FAILED"; result: SocialPublished }
  | { status: "NOT_PUBLISHED" }
  | { status: "PENDING" | "UNKNOWN" };

/** Platform-specific upload/processing lives here, independently of Ads adapters. */
export interface SocialProvider {
  validate(context: SocialProviderContext): Promise<void>;
  prepare(context: SocialProviderContext, progress: SocialProgress): Promise<SocialProgress>;
  publish(context: SocialProviderContext, progress: SocialProgress): Promise<SocialPublished>;
  status(context: SocialProviderContext, progress: SocialProgress): Promise<SocialStatusResult>;
  cancel?(context: SocialProviderContext, progress: SocialProgress): Promise<{ cancelled: boolean }>;
}
export type SocialProviderRegistration = {
  platform: Platform; kind: DestinationKind; modes: readonly SocialMode[];
  requiredScopes: readonly string[]; formats: readonly SocialFormat[];
  mediaFetchWindowMs?: number;
  renewableCredentials?: boolean;
  validateContent?: (content: SocialProviderContext["content"], media: readonly SocialMediaAsset[]) => void;
  factory: () => SocialProvider;
};
export class SocialProviderRegistry {
  private readonly issued = new WeakSet<SocialProvider>();
  private readonly providers = new Map<string, SocialProviderRegistration>();
  register(registration: SocialProviderRegistration) {
    const key = `${registration.platform}:${registration.kind}`;
    if (!registration.modes.length || !registration.formats.length || registration.requiredScopes.some((s) => !s || s.length > 512))
      throw new Error("Invalid social provider registration.");
    this.providers.set(key, Object.freeze({ ...registration, requiredScopes: Object.freeze([...registration.requiredScopes]),
      formats: Object.freeze([...registration.formats]), modes: Object.freeze([...registration.modes]) }));
  }
  get(platform: Platform, kind: DestinationKind) { return this.providers.get(`${platform}:${kind}`); }
  create(platform: Platform, kind: DestinationKind) {
    const registration = this.get(platform, kind);
    if (!registration) fail("PROVIDER_DISABLED", 503, "This social provider is unavailable.");
    const provider = registration.factory();
    if (!provider || this.issued.has(provider)) fail("INVALID_PROVIDER_PROTOCOL", 503, "Social provider instances must be isolated per delivery.");
    this.issued.add(provider); return provider;
  }
}

/** Only explicitly classified provider failures may schedule a bounded safe retry. */
export class SocialProviderFailure extends Error {
  constructor(readonly kind: "RATE_LIMIT" | "TRANSIENT" | "EXPIRED" | "TERMINAL",
    readonly definitive = false, readonly retryAfterMs?: number) {
    super("The social provider request could not be completed.");
  }
}
export type SocialWorkerConfig = {
  mode: SocialMode; writesEnabled: boolean; approvedProviders: readonly string[];
  leaseMs?: number; maxAttempts?: number; maxBackoffMs?: number;
};
export type SocialCredentialRenewal = (request: {
  authorizationId: string; ownerId: string; authorizationGeneration: number; credentialVersion: number; mode: SocialMode;
  provider: Platform; providerUserId: string; refreshToken: string; scopes: string[];
  /** X renewal must reserve its billable identity read before rotating the token. */
  maxApiCostMicros?: number;
  authorizeApiCost?(input: { operation: string; costMicros: number; maxApiCostMicros: number }): Promise<void>;
  verifyCurrent(): Promise<void>;
}) => Promise<ProviderGrant>;
