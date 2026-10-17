/** Trusted adapter output, never a public request schema. */
export type TrackingProvider = "NATIVE" | "API" | "CALENDLY" | "SHOPIFY";
export type TrackingEnvironment = "TEST" | "LIVE";
export type TrackingMode = "LIVE" | "BACKFILL" | "REPLAY";
export type Reference = { kind: string; id: string };
/** API business-reference handoff; generation is captured by receipt acceptance, never supplied by a caller. */
export type BusinessReference = Reference & { sourceId?: string; sourceGeneration?: number };
export type TrackingSourceConfig = {
  allowedOrigins: string[];
  allowedEvents: string[];
  propertyKeys: string[];
  correlationField?: "utm_content";
};
export type AdapterSource = {
  id: string; ownerId: string; provider: TrackingProvider;
  environment: TrackingEnvironment; externalAccountId: string;
  config: TrackingSourceConfig;
};
export type SourceCredentials = { signingSecret?: string; apiToken?: string };
export type NormalizedTrackingEvent = {
  type: string;
  dedupeKey: string;
  providerTopic: string;
  providerDeliveryId?: string;
  providerEventId?: string;
  providerApiVersion?: string;
  factKey?: string;
  occurredAt: string;
  resourceUpdatedAt?: string;
  authority: "BROWSER_OBSERVED" | "SERVER_ASSERTED" | "PROVIDER_VERIFIED" | "USER_RECORDED";
  verification: string;
  resource: Reference;
  references: BusinessReference[];
  subjectKind?: "CONTACT" | "SALES" | "PURCHASE" | "SUBSCRIPTION";
  createsSubject?: boolean;
  contactIdentity?: Reference;
  contact?: { email?: string; name?: string };
  properties: Record<string, string | number | boolean | null>;
  correlationToken?: string;
  correlationEmail?: string;
  quarantineReason?: string;
};
export type ProviderReceipt = { events: NormalizedTrackingEvent[]; rawPayloadDigest: string };
export type ReconcileResource = { kind: "BOOKING" | "ORDER" | "REFUND"; id: string };
