import { createHmac, randomBytes } from "node:crypto";
import type { Prisma, PrismaClient, TrackingSource } from "../../generated/prisma/client";
import { CustomerAuth, type CustomerPrincipal } from "../auth/customerAuth";
import { CredentialVault } from "../security/credentialVault";
import { fail } from "../security/errors";
import { verifyProviderReceipt, reconcileProviderResource } from "./providerTracking";
import type { AdapterSource, BusinessReference, NormalizedTrackingEvent, ReconcileResource, SourceCredentials, TrackingMode, TrackingSourceConfig } from "./trackingTypes";
import { enqueueFunnelEvaluation, eraseFunnelSubjects } from "./funnelLifecycle";
import { eraseEmailContact } from "../email/emailPolicy";
import { email, emailKey, equalSecret, fields, json, object, properties, sha256, strings, text, timestamp } from "./trackingValidation";

type Tx = Prisma.TransactionClient;
const jsonValue = (value: unknown) => JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
const DAY = 86_400_000;
const browserTypes = ["page.viewed", "product.viewed", "checkout.observed"];
const sourceTypes = ["enquiry.accepted", "deal.won", "deal.lost", "order.paid", ...browserTypes];
const subjectReferences: Record<string, string[]> = { CONTACT: ["CONTACT"], SALES: ["ENQUIRY", "DEAL", "BOOKING"], PURCHASE: ["ORDER", "CHECKOUT", "REFUND", "REFUND_TRANSACTION"] };
const matchingKinds = Object.values(subjectReferences).flat();
const handoffKinds: Record<string, string[]> = { NATIVE: ["ENQUIRY"], API: matchingKinds,
  CALENDLY: ["BOOKING"], SHOPIFY: ["ORDER", "CHECKOUT", "REFUND", "REFUND_TRANSACTION"] };
const providerTypes: Record<string, string[]> = {
  NATIVE: ["enquiry.accepted", ...browserTypes], API: sourceTypes,
  CALENDLY: ["booking.confirmed", "booking.cancelled"], SHOPIFY: ["order.paid", "refund.created", "refund.succeeded"],
};

/** Receipt and matching are separate durable transactions. No network operation runs inside either. */
export class TrackingService {
  constructor(private readonly db: PrismaClient, private readonly auth: CustomerAuth, private readonly vault: CredentialVault,
    private readonly now = () => new Date(), private readonly liveEnabled = false) {}

  private async session(tx: Tx, principal: CustomerPrincipal) {
    if (!await tx.customerSession.findFirst({ where: { id: principal.sessionId, userId: principal.userId, expiresAt: { gt: this.now() } } }))
      fail("UNAUTHENTICATED", 401, "Sign in to continue.");
  }
  private async owned(tx: Tx | PrismaClient, principal: CustomerPrincipal, id: string) {
    const source = await tx.trackingSource.findFirst({ where: { id, ownerId: principal.userId } });
    if (!source) fail("NOT_FOUND", 404, "Tracking source not found.");
    return source;
  }
  private usable(source: TrackingSource | null): asserts source is TrackingSource {
    if (!source || source.status !== "ACTIVE") fail("TRACKING_SOURCE_UNAVAILABLE", 404, "Tracking source is unavailable.");
    if (source.environment === "LIVE" && !this.liveEnabled) fail("TRACKING_LIVE_DISABLED", 503, "Live tracking is not enabled on this deployment.");
  }
  private adapterSource(source: TrackingSource): AdapterSource { return { ...source, config: source.config } as unknown as AdapterSource; }
  private credentials(source: TrackingSource): SourceCredentials {
    return source.credentialCiphertext ? JSON.parse(this.vault.decrypt(source.credentialCiphertext, `${source.ownerId}:${source.id}:tracking`)) : {};
  }
  private credentialsInput(value: unknown): SourceCredentials {
    const input = object(value ?? {}); fields(input, ["signingSecret", "apiToken"]);
    return { ...(input.signingSecret === undefined ? {} : { signingSecret: text(input.signingSecret, 4096) }),
      ...(input.apiToken === undefined ? {} : { apiToken: text(input.apiToken, 4096) }) };
  }
  private config(value: unknown, provider: string): TrackingSourceConfig {
    const input = object(value ?? {}); fields(input, ["allowedOrigins", "allowedEvents", "propertyKeys", "correlationField"]);
    const allowedOrigins = strings(input.allowedOrigins ?? [], 10).map(origin => {
      let url: URL; try { url = new URL(origin); } catch { fail("INVALID_TRACKING_INPUT", 400, "Use exact site origins."); }
      if (url.origin !== origin || url.username || url.password || (url.protocol !== "https:" && !["localhost", "127.0.0.1"].includes(url.hostname)))
        fail("INVALID_TRACKING_INPUT", 400, "Use exact HTTPS origins or local development origins.");
      return origin;
    });
    if (provider === "NATIVE" && !allowedOrigins.length) fail("INVALID_TRACKING_INPUT", 400, "Configure at least one form or website origin.");
    const allowedEvents = strings(input.allowedEvents ?? providerTypes[provider]);
    if (allowedEvents.some(type => !providerTypes[provider].includes(type) && !(provider === "API" && /^custom\.[a-z][a-z0-9_.]{0,63}$/.test(type))))
      fail("INVALID_TRACKING_INPUT", 400, "Choose events this source can produce.");
    const propertyKeys = strings(input.propertyKeys ?? ["path", "referrer", "utm_source", "utm_medium", "utm_campaign", "utm_content", "campaign", "consent"], 30);
    if (propertyKeys.some(key => !/^[a-zA-Z][a-zA-Z0-9_]{0,63}$/.test(key) || /password|secret|token|authorization/i.test(key)))
      fail("INVALID_TRACKING_INPUT", 400, "Choose non-secret property names.");
    if (input.correlationField !== undefined && (provider !== "CALENDLY" || input.correlationField !== "utm_content"))
      fail("INVALID_TRACKING_INPUT", 400, "Only the documented Calendly tracking field is supported.");
    return { allowedOrigins, allowedEvents, propertyKeys, ...(input.correlationField ? { correlationField: "utm_content" as const } : {}) };
  }
  private dto(source: TrackingSource) {
    return { id: source.id, name: source.name, provider: source.provider, environment: source.environment,
      externalAccountId: source.externalAccountId, status: source.status, generation: source.generation,
      config: source.config, credentialsSaved: source.provider === "RESEND" ? undefined : !!source.credentialCiphertext,
      ...(source.provider === "RESEND" ? { credentialsManagedBy: "EMAIL_CONNECTION" } : {}), createdAt: source.createdAt };
  }
  async createSource(principal: CustomerPrincipal, value: unknown) {
    await this.auth.assertSession(principal);
    const input = object(value); fields(input, ["name", "provider", "environment", "externalAccountId", "config", "credentials"]);
    const provider = text(input.provider), environment = text(input.environment), name = text(input.name), externalAccountId = text(input.externalAccountId, 300);
    if (!providerTypes[provider] || !["TEST", "LIVE"].includes(environment)) fail("INVALID_TRACKING_INPUT", 400, "Choose a supported provider and environment.");
    if (environment === "LIVE" && !this.liveEnabled) fail("TRACKING_LIVE_DISABLED", 503, "Live tracking is not enabled on this deployment.");
    if (provider === "SHOPIFY" && !/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(externalAccountId) ||
      provider === "CALENDLY" && !/^https:\/\/api\.calendly\.com\/users\/[A-Za-z0-9_-]+$/.test(externalAccountId))
      fail("INVALID_TRACKING_INPUT", 400, "Use the canonical store hostname or Calendly user URI.");
    const config = this.config(input.config, provider), credentials = this.credentialsInput(input.credentials);
    if (provider === "API" && !credentials.signingSecret) credentials.signingSecret = randomBytes(32).toString("base64url");
    if (provider !== "NATIVE" && (!credentials.signingSecret || credentials.signingSecret.length < 16))
      fail("INVALID_TRACKING_INPUT", 400, "Configure the source signing secret.");
    if (provider === "NATIVE" && Object.keys(credentials).length) fail("INVALID_TRACKING_INPUT", 400, "Native sources do not use provider credentials.");
    const ingressToken = randomBytes(32).toString("base64url");
    const source = await this.db.$transaction(async tx => {
      await this.session(tx, principal);
      const result = await tx.trackingSource.create({ data: { ownerId: principal.userId, provider, environment, name, externalAccountId,
        config: jsonValue(config), ingressTokenHash: sha256(ingressToken) } });
      return tx.trackingSource.update({ where: { id: result.id }, data: { credentialCiphertext: provider === "NATIVE" ? null :
        this.vault.encrypt(JSON.stringify(credentials), `${principal.userId}:${result.id}:tracking`) } });
    });
    return { source: this.dto(source), ...(provider === "API" ? { signingSecret: credentials.signingSecret } : {}),
      ...(["SHOPIFY", "CALENDLY"].includes(provider) ? { ingressToken } : {}) };
  }
  async updateSource(principal: CustomerPrincipal, id: string, value: unknown) {
    await this.auth.assertSession(principal);
    const input = object(value); fields(input, ["status", "credentials", "config", "rotateIngress"]);
    if (input.status !== undefined && !["ACTIVE", "PAUSED", "DISCONNECTED"].includes(String(input.status)) || input.rotateIngress !== undefined && input.rotateIngress !== true)
      fail("INVALID_TRACKING_INPUT", 400, "Choose a supported source operation.");
    const ingressToken = input.rotateIngress ? randomBytes(32).toString("base64url") : undefined;
    const source = await this.db.$transaction(async tx => {
      await this.session(tx, principal); const source = await this.owned(tx, principal, id);
      if (source.provider === "RESEND") fail("MANAGED_EMAIL_SOURCE", 409, "Manage this source through its email connection.");
      const credentials = input.credentials === undefined ? undefined : this.credentialsInput(input.credentials);
      if (credentials && source.provider !== "NATIVE" && (!credentials.signingSecret || credentials.signingSecret.length < 16))
        fail("INVALID_TRACKING_INPUT", 400, "Supply the complete replacement signing credentials.");
      if (credentials && source.provider === "NATIVE") fail("INVALID_TRACKING_INPUT", 400, "Native sources do not use provider credentials.");
      return tx.trackingSource.update({ where: { id }, data: { generation: { increment: 1 }, status: input.status as string | undefined,
        ...(input.config === undefined ? {} : { config: jsonValue(this.config(input.config, source.provider)) }),
        ...(ingressToken ? { ingressTokenHash: sha256(ingressToken) } : {}),
        ...(credentials ? { credentialCiphertext: this.vault.encrypt(JSON.stringify(credentials), `${source.ownerId}:${id}:tracking`) } : {}) } });
    });
    return { source: this.dto(source), ...(ingressToken ? { ingressToken } : {}) };
  }
  private environment(value: string) {
    if (!["TEST", "LIVE"].includes(value)) fail("INVALID_TRACKING_INPUT", 400, "Choose an environment.");
    return value;
  }
  private async sourceSummary(source: TrackingSource) {
    const [last, matched, unresolved, conflicts] = await Promise.all([
      this.db.trackingEvent.findFirst({ where: { sourceId: source.id }, orderBy: [{ receivedAt: "desc" }, { id: "desc" }],
        select: { id: true, receivedAt: true, occurredAt: true, type: true, status: true, reason: true, subjectId: true } }),
      this.db.trackingEvent.count({ where: { sourceId: source.id, status: "MATCHED" } }),
      this.db.trackingEvent.count({ where: { sourceId: source.id, status: { in: ["UNMATCHED", "QUARANTINED", "BLOCKED"] } } }),
      this.db.trackingEvent.count({ where: { sourceId: source.id, conflictCount: { gt: 0 } } }),
    ]);
    return { ...this.dto(source), health: { configured: source.status === "ACTIVE", receivingEvents: !!last, matchedEvents: matched,
      unresolvedEvents: unresolved, conflictingEvents: conflicts, lastReceipt: last, readyForAutomation: false,
      explanation: source.status !== "ACTIVE" ? "Source is paused or disconnected." : !last ? "Configured; no accepted traffic yet." :
        !matched ? "Events received; identity matching is not yet established." : "Verified matching is available. Publish a compatible funnel and enable actions separately." } };
  }
  async listSources(principal: CustomerPrincipal, environment?: string) {
    await this.auth.assertSession(principal);
    const sources = await this.db.trackingSource.findMany({ where: { ownerId: principal.userId,
      ...(environment === undefined ? {} : { environment: this.environment(environment) }) }, orderBy: { createdAt: "desc" }, take: 100 });
    return Promise.all(sources.map(source => this.sourceSummary(source)));
  }
  async source(principal: CustomerPrincipal, id: string, environment?: string) {
    await this.auth.assertSession(principal); const source = await this.owned(this.db, principal, id);
    if (environment !== undefined && source.environment !== this.environment(environment)) fail("NOT_FOUND", 404, "Tracking source not found in this environment.");
    return this.sourceSummary(source);
  }
  async events(principal: CustomerPrincipal, sourceId: string, cursor?: string, options: { order?: string; environment?: string; eventId?: string } = {}) {
    await this.auth.assertSession(principal); const source = await this.owned(this.db, principal, sourceId);
    if (options.environment !== undefined && source.environment !== this.environment(options.environment)) fail("NOT_FOUND", 404, "Tracking source not found in this environment.");
    if (options.order !== undefined && !["newest", "oldest"].includes(options.order)) fail("INVALID_TRACKING_INPUT", 400, "Choose newest or oldest event order.");
    if (cursor && options.eventId) fail("INVALID_TRACKING_INPUT", 400, "Choose a cursor or a specific event.");
    if (cursor || options.eventId) {
      const found = await this.db.trackingEvent.findFirst({ where: { id: text(cursor ?? options.eventId), sourceId, ownerId: principal.userId } });
      if (!found) fail("NOT_FOUND", 404, "Event not found.");
    }
    const events = await this.db.trackingEvent.findMany({ where: { sourceId, ownerId: principal.userId,
      ...(options.eventId ? { id: options.eventId } : {}) },
      orderBy: options.order === "newest" ? [{ receivedAt: "desc" }, { id: "desc" }] : { id: "asc" },
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}), take: 51 });
    const page = events.slice(0, 50);
    return { events: page.map(e => ({ id: e.id, type: e.type, environment: e.environment, status: e.status, reason: e.reason,
      subjectId: e.subjectId, contactId: e.contactId, factId: e.factId, occurredAt: e.occurredAt, receivedAt: e.receivedAt,
      ingestionMode: e.ingestionMode, processingMode: e.processingMode, late: e.late, duplicates: e.duplicateCount, conflicts: e.conflictCount,
      evidence: e.status === "REDACTED" ? null : (() => {
        const value = e.envelope as unknown as NormalizedTrackingEvent;
        return { resource: value.resource, references: value.references, subjectKind: value.subjectKind ?? (e.type.startsWith("booking.") ? "SALES" : e.type.startsWith("refund.") ? "PURCHASE" : "CONTACT"),
          authority: value.authority, verification: value.verification, properties: value.properties,
          providerTopic: value.providerTopic, resourceUpdatedAt: value.resourceUpdatedAt };
      })() })), nextCursor: events.length > 50 ? page.at(-1)!.id : null };
  }
  async subjects(principal: CustomerPrincipal, environment: string) {
    await this.auth.assertSession(principal); this.environment(environment);
    const subjects = await this.db.funnelSubject.findMany({ where: { ownerId: principal.userId, environment }, orderBy: { createdAt: "desc" }, take: 100,
      select: { id: true, kind: true, contactId: true, environment: true, createdAt: true,
        contact: { select: { id: true, name: true, email: true, deletedAt: true } } } });
    return subjects.map(({ contact, ...subject }) => ({ ...subject,
      contact: contact && !contact.deletedAt ? { id: contact.id, name: contact.name, email: contact.email } : null }));
  }
  async contacts(principal: CustomerPrincipal, environment: string, options: { cursor?: string; query?: string } = {}) {
    await this.auth.assertSession(principal); this.environment(environment);
    if (options.query !== undefined && (options.query.length > 100 || /[\u0000-\u001f]/.test(options.query)))
      fail("INVALID_TRACKING_INPUT", 400, "Use a short contact search without control characters.");
    const query = options.query?.trim() ?? "";
    const where = { ownerId: principal.userId, environment, deletedAt: null,
      ...(query ? { OR: [{ name: { contains: query } }, { email: { contains: query } }] } : {}) };
    if (options.cursor && !await this.db.funnelContact.findFirst({ where: { ...where, id: text(options.cursor, 128) }, select: { id: true } }))
      fail("NOT_FOUND", 404, "Contact cursor not found.");
    const contacts = await this.db.funnelContact.findMany({ where, orderBy: { id: "asc" },
      ...(options.cursor ? { cursor: { id: options.cursor }, skip: 1 } : {}), take: 51,
      select: { id: true, environment: true, name: true, email: true, createdAt: true } });
    return { contacts: contacts.slice(0, 50), nextCursor: contacts.length > 50 ? contacts[49].id : null };
  }
  private async rate(source: TrackingSource) {
    const bucket = new Date(Math.floor(this.now().getTime() / 60_000) * 60_000);
    const result = await this.db.$transaction(async tx => {
      await tx.trackingRateLimit.deleteMany({ where: { sourceId: source.id, bucket: { lt: new Date(bucket.getTime() - 3_600_000) } } });
      return tx.trackingRateLimit.upsert({ where: { sourceId_bucket: { sourceId: source.id, bucket } },
        create: { ownerId: source.ownerId, environment: source.environment, sourceId: source.id, bucket, count: 1 }, update: { count: { increment: 1 } } });
    });
    if (result.count > (source.provider === "NATIVE" ? 120 : 600)) fail("TRACKING_RATE_LIMIT", 429, "Source rate limit reached. Retry later.");
  }
  async publicSource(sourceId: string, origin: string | null) {
    const source = await this.db.trackingSource.findUnique({ where: { id: sourceId } }); this.usable(source);
    if (source.provider !== "NATIVE" || !origin || !(source.config as unknown as TrackingSourceConfig).allowedOrigins.includes(origin))
      fail("INVALID_ORIGIN", 403, "The site origin is not allowed for this source.");
    return source;
  }
  async visitor(sourceId: string, origin: string | null) {
    const source = await this.publicSource(sourceId, origin); await this.rate(source);
    const token = randomBytes(32).toString("base64url");
    await this.db.$transaction(async tx => {
      const current = await tx.trackingSource.findFirst({ where: { id: source.id, generation: source.generation, status: "ACTIVE" } });
      if (!current) fail("TRACKING_SOURCE_UNAVAILABLE", 409, "Source changed; retry the request.");
      await tx.trackingVisitor.create({ data: { ownerId: source.ownerId, environment: source.environment, sourceId, tokenHash: sha256(token), expiresAt: new Date(this.now().getTime() + DAY) } });
    });
    return { visitorToken: token, expiresInSeconds: 86400 };
  }
  async collectNative(sourceId: string, origin: string | null, raw: string, form: boolean) {
    const source = await this.publicSource(sourceId, origin); await this.rate(source);
    const input = json(raw); fields(input, form ? ["schemaVersion", "eventId", "visitorToken", "name", "email", "properties"] :
      ["schemaVersion", "eventId", "visitorToken", "type", "properties"]);
    if (input.schemaVersion !== 1) fail("UNSUPPORTED_EVENT_SCHEMA", 400, "Use event schema version 1.");
    const eventId = text(input.eventId, 128), type = form ? "enquiry.accepted" : text(input.type), config = source.config as unknown as TrackingSourceConfig;
    if (!config.allowedEvents.includes(type) || !form && !browserTypes.includes(type)) fail("UNSUPPORTED_EVENT", 400, "This browser source cannot assert that event.");
    let visitorId: string | undefined;
    if (input.visitorToken !== undefined) {
      const visitor = await this.db.trackingVisitor.findFirst({ where: { sourceId, tokenHash: sha256(text(input.visitorToken, 100)), expiresAt: { gt: this.now() } } });
      if (!visitor) fail("INVALID_VISITOR", 400, "Start a new anonymous visit.");
      visitorId = visitor.id;
    }
    const event: NormalizedTrackingEvent = { type, dedupeKey: eventId, providerTopic: type, occurredAt: this.now().toISOString(),
      authority: form ? "SERVER_ASSERTED" : "BROWSER_OBSERVED", verification: "ACCEPTED_NATIVE_SUBMISSION",
      resource: { kind: form ? "ENQUIRY" : "OBSERVATION", id: eventId }, references: [],
      subjectKind: "SALES", createsSubject: form, ...(form ? { contact: { email: email(input.email), name: text(input.name, 200, true) || undefined } } : {}),
      properties: properties(input.properties, config.propertyKeys) };
    return this.accept(source, [event], sha256(raw), "LIVE", visitorId);
  }
  async collectApi(sourceId: string, headers: Headers, raw: string) {
    const source = await this.db.trackingSource.findUnique({ where: { id: sourceId } }); this.usable(source);
    if (source.provider !== "API") fail("TRACKING_SOURCE_UNAVAILABLE", 404, "API source not found.");
    const seconds = headers.get("x-launchpad-timestamp") ?? "", requestId = headers.get("x-launchpad-id") ?? "", signature = headers.get("x-launchpad-signature") ?? "";
    if (!/^\d{10,11}$/.test(seconds) || Math.abs(this.now().getTime() - Number(seconds) * 1000) > 180_000 || !/^[A-Za-z0-9_-]{8,128}$/.test(requestId) || !/^[a-f0-9]{64}$/.test(signature))
      fail("INVALID_TRACKING_SIGNATURE", 401, "Invalid source authentication.");
    const expected = createHmac("sha256", this.credentials(source).signingSecret!).update(`${seconds}.${requestId}.${raw}`).digest("hex");
    if (!equalSecret(signature, expected)) fail("INVALID_TRACKING_SIGNATURE", 401, "Invalid source authentication.");
    await this.rate(source);
    const input = json(raw); fields(input, ["schemaVersion", "type", "occurredAt", "resource", "references", "subjectKind", "contactIdentity", "contact", "properties"]);
    const type = text(input.type), config = source.config as unknown as TrackingSourceConfig;
    if (input.schemaVersion !== 1 || !config.allowedEvents.includes(type)) fail("UNSUPPORTED_EVENT", 400, "Use the configured event schema and types.");
    const ref = (value: unknown, qualified = false): BusinessReference => { const r = object(value); fields(r, qualified ? ["kind", "id", "sourceId"] : ["kind", "id"]); const kind = text(r.kind, 30);
      if (!matchingKinds.includes(kind)) fail("INVALID_TRACKING_INPUT", 400, "Use a supported business reference kind.");
      return { kind, id: text(r.id, 500), ...(r.sourceId === undefined ? {} : { sourceId: text(r.sourceId, 200) }) }; };
    const resource = ref(input.resource), references = input.references === undefined ? [] : input.references;
    if (!Array.isArray(references) || references.length > 10) fail("INVALID_TRACKING_INPUT", 400, "Supply at most ten references.");
    const subjectKind = text(input.subjectKind);
    if (!["CONTACT", "SALES", "PURCHASE"].includes(subjectKind)) fail("INVALID_TRACKING_INPUT", 400, "Choose the subject kind.");
    const parsedReferences = references.map(value => ref(value, true));
    if (![resource, ...parsedReferences].every(r => subjectReferences[subjectKind].includes(r.kind)))
      fail("INVALID_TRACKING_INPUT", 400, "Keep contact identity separate from enquiry/order business references.");
    let contactIdentity: { kind: string; id: string } | undefined, contact: { name?: string; email?: string } | undefined;
    if (input.contactIdentity !== undefined) { const c = object(input.contactIdentity); fields(c, ["kind", "id"]); contactIdentity = { kind: text(c.kind, 50), id: text(c.id, 500) }; }
    if (input.contact !== undefined) { const c = object(input.contact); fields(c, ["email", "name"]);
      if (!contactIdentity) fail("INVALID_TRACKING_INPUT", 400, "Contact data requires a stable source identity.");
      contact = { ...(c.email ? { email: email(c.email) } : {}), ...(c.name ? { name: text(c.name) } : {}) }; }
    const attrs = properties(input.properties, config.propertyKeys);
    if (["order.paid", "deal.won"].includes(type) && (typeof attrs.amount !== "string" || !/^\d{1,15}(\.\d{1,6})?$/.test(attrs.amount) || typeof attrs.currency !== "string" || !/^[A-Z]{3}$/.test(attrs.currency)))
      fail("INVALID_TRACKING_INPUT", 400, "Financial events require a decimal amount and explicit currency.");
    if (type === "order.paid" && subjectKind !== "PURCHASE" || type.startsWith("deal.") && subjectKind !== "SALES")
      fail("INVALID_TRACKING_INPUT", 400, "The event does not match the business subject kind.");
    return this.accept(source, [{ type, dedupeKey: requestId, providerTopic: type, occurredAt: timestamp(input.occurredAt),
      authority: "SERVER_ASSERTED", verification: "HMAC_SHA256_TIMESTAMP_REQUEST_BODY", resource, references: parsedReferences,
      subjectKind: subjectKind as "CONTACT" | "SALES" | "PURCHASE", createsSubject: true, contactIdentity, contact, properties: attrs,
      ...(["order.paid", "deal.won"].includes(type) ? { factKey: type } : {}) }], sha256(raw), "LIVE");
  }
  async collectHook(ingressToken: string, headers: Headers, raw: string) {
    if (!/^[A-Za-z0-9_-]{43}$/.test(ingressToken)) fail("TRACKING_SOURCE_UNAVAILABLE", 404, "Webhook source not found.");
    const source = await this.db.trackingSource.findUnique({ where: { ingressTokenHash: sha256(ingressToken) } }); this.usable(source);
    if (!["CALENDLY", "SHOPIFY"].includes(source.provider)) fail("TRACKING_SOURCE_UNAVAILABLE", 404, "Webhook source not found.");
    await this.rate(source);
    const receipt = verifyProviderReceipt(this.adapterSource(source), this.credentials(source), headers, raw, this.now());
    return this.accept(source, receipt.events, receipt.rawPayloadDigest, "LIVE");
  }
  private async accept(source: TrackingSource, events: NormalizedTrackingEvent[], rawPayloadDigest: string, mode: TrackingMode, visitorId?: string, actor?: CustomerPrincipal) {
    if (!events.length || events.length > 200) fail("INVALID_TRACKING_INPUT", 400, "Unsupported event batch size.");
    const result = await this.db.$transaction(async tx => {
      if (actor) await this.session(tx, actor);
      const current = await tx.trackingSource.findFirst({ where: { id: source.id, generation: source.generation, status: "ACTIVE" } });
      if (!current) fail("TRACKING_SOURCE_CHANGED", 409, "Source changed before receipt. Retry with current credentials.");
      const receipts: { id: string; duplicate: boolean; conflict: boolean }[] = [];
      for (const event of events) {
        const existing = await tx.trackingEvent.findUnique({ where: { ownerId_sourceId_type_dedupeKey: {
          ownerId: source.ownerId, sourceId: source.id, type: event.type, dedupeKey: event.dedupeKey } } });
        if (existing) {
          const conflict = existing.rawPayloadDigest !== rawPayloadDigest;
          await tx.trackingEvent.update({ where: { id: existing.id }, data: conflict ? { conflictCount: { increment: 1 } } : { duplicateCount: { increment: 1 } } });
          if (conflict) await tx.trackingAudit.create({ data: { ownerId: source.ownerId, environment: source.environment, sourceId: source.id,
            eventId: existing.id, action: "DELIVERY_CONFLICT", reason: "Delivery key was reused with a different payload digest." } });
          receipts.push({ id: existing.id, duplicate: !conflict, conflict }); continue;
        }
        // Only signed API references may declare another namespace. Authentication has already
        // succeeded; capture authority in this transaction and retain it unchanged on replay.
        const references: BusinessReference[] = [];
        for (const ref of event.references) {
          if (ref.sourceId !== undefined) {
            const target = await tx.trackingSource.findFirst({ where: { id: ref.sourceId, ownerId: source.ownerId,
              environment: source.environment, status: "ACTIVE" } });
            if (source.provider !== "API" || !target || !handoffKinds[target.provider]?.includes(ref.kind))
              fail("INVALID_HANDOFF_REFERENCE", 400, "Choose an active, owned source in the same environment that supports this reference kind.");
            references.push({ kind: ref.kind, id: ref.id, sourceId: target.id, sourceGeneration: target.generation });
          } else references.push(ref);
        }
        const uniqueReferences = new Map<string, BusinessReference>();
        for (const ref of references) {
          const key = JSON.stringify([ref.sourceId ?? source.id, ref.kind, ref.id]), prior = uniqueReferences.get(key);
          if (!prior || ref.sourceGeneration !== undefined) uniqueReferences.set(key, ref);
        }
        const occurredAt = new Date(timestamp(event.occurredAt));
        const reason = event.quarantineReason ?? (!(source.config as unknown as TrackingSourceConfig).allowedEvents.includes(event.type) ? "SOURCE_EVENT_DISABLED" :
          occurredAt.getTime() > this.now().getTime() + 300_000 ? "FUTURE_TIMESTAMP" : undefined);
        const eventId = await tx.trackingEvent.create({ data: { ownerId: source.ownerId, environment: source.environment,
          sourceId: source.id, sourceGeneration: source.generation, type: event.type, dedupeKey: event.dedupeKey, rawPayloadDigest,
          envelope: jsonValue({ ...event, references: [...uniqueReferences.values()], schemaVersion: 1, normalizationVersion: 1, dedupeKeyVersion: 1, provider: source.provider }), ingestionMode: mode, processingMode: mode,
          occurredAt, receivedAt: this.now(), expiresAt: new Date(this.now().getTime() + 180 * DAY), visitorId,
          status: reason ? "QUARANTINED" : "QUEUED", reason } });
        receipts.push({ id: eventId.id, duplicate: false, conflict: false });
      }
      return receipts;
    });
    if (result.some(r => r.conflict)) fail("IDEMPOTENCY_CONFLICT", 409, "A receipt key has different content. Review source diagnostics before retrying.");
    return { accepted: true, receipts: result };
  }

  async createCorrelation(principal: CustomerPrincipal, sourceId: string, value: unknown) {
    await this.auth.assertSession(principal); const input = object(value); fields(input, ["subjectId"]);
    const token = randomBytes(32).toString("base64url");
    const expiresAt = new Date(this.now().getTime() + 7 * DAY);
    await this.db.$transaction(async tx => {
      await this.session(tx, principal); const source = await this.owned(tx, principal, sourceId); this.usable(source);
      if (source.provider !== "CALENDLY" || (source.config as unknown as TrackingSourceConfig).correlationField !== "utm_content")
        fail("UNSUPPORTED_CORRELATION", 400, "Configure Calendly tracking correlation first.");
      const subject = await tx.funnelSubject.findFirst({ where: { id: text(input.subjectId), ownerId: principal.userId, environment: source.environment, kind: "SALES" } });
      const contact = subject?.contactId ? await tx.funnelContact.findFirst({ where: { id: subject.contactId, deletedAt: null } }) : null;
      if (!subject || !contact?.email) fail("INVALID_CORRELATION", 400, "Choose an owned enquiry with a known recipient email.");
      await tx.trackingCorrelation.create({ data: { ownerId: source.ownerId, environment: source.environment, sourceId,
        subjectId: subject.id, tokenHash: sha256(token), emailDigest: sha256(emailKey(contact.email)), expiresAt } });
    });
    return { token, field: "utm_content", expiresAt, note: "Confirm the configured booking page returns this field. Recipient evidence is also checked." };
  }

  async processOnce() {
    return this.db.$transaction(async tx => {
      const event = await tx.trackingEvent.findFirst({ where: { status: "QUEUED" }, orderBy: [{ receivedAt: "asc" }, { id: "asc" }] });
      if (!event) return null;
      const source = await tx.trackingSource.findUniqueOrThrow({ where: { id: event.sourceId } });
      if (source.status !== "ACTIVE" || (event.processingMode === "LIVE" && source.generation !== event.sourceGeneration) || source.environment === "LIVE" && !this.liveEnabled)
        return tx.trackingEvent.update({ where: { id: event.id }, data: { status: "BLOCKED", reason: "SOURCE_CHANGED", processedAt: this.now() } });
      const envelope = event.envelope as unknown as NormalizedTrackingEvent;
      const kind = envelope.subjectKind ?? (event.type.startsWith("booking.") ? "SALES" : event.type.startsWith("refund.") ? "PURCHASE" : "CONTACT");
      const refs = [envelope.resource, ...envelope.references].filter(r => subjectReferences[kind].includes(r.kind))
        .map((ref: BusinessReference) => ({ ...ref, sourceId: ref.sourceId ?? source.id }));
      // Target authority is pinned at acceptance, including during history-only replay/manual matching.
      for (const ref of envelope.references) if (ref.sourceId !== undefined) {
        const target = await tx.trackingSource.findFirst({ where: { id: ref.sourceId, ownerId: event.ownerId,
          environment: event.environment, status: "ACTIVE", generation: ref.sourceGeneration ?? -1 } });
        if (source.provider !== "API" || !target || !handoffKinds[target.provider]?.includes(ref.kind))
          return tx.trackingEvent.update({ where: { id: event.id }, data: { status: "BLOCKED", reason: "REFERENCE_SOURCE_CHANGED", processedAt: this.now() } });
      }
      for (const ref of refs) {
        const deleted = await tx.trackingDeletion.findUnique({ where: { ownerId_sourceId_namespace_externalIdDigest: { ownerId: source.ownerId, sourceId: ref.sourceId, namespace: `SUBJECT:${ref.kind}`, externalIdDigest: sha256(ref.id) } } });
        if (deleted) return tx.trackingEvent.update({ where: { id: event.id }, data: { status: "REDACTED", envelope: {}, reason: "DELETED_SUBJECT", processedAt: this.now() } });
      }
      const mappings = refs.length ? await tx.funnelSubjectReference.findMany({ where: { ownerId: source.ownerId,
        OR: refs.map(r => ({ sourceId: r.sourceId, kind: r.kind, externalId: r.id })) } }) : [];
      const candidates = new Set(mappings.map(r => r.subjectId));
      let reason = "NO_VERIFIED_BUSINESS_REFERENCE";
      if (envelope.correlationToken) {
        const correlation = await tx.trackingCorrelation.findFirst({ where: { sourceId: source.id, tokenHash: sha256(envelope.correlationToken), expiresAt: { gt: this.now() } } });
        if (correlation && envelope.correlationEmail && equalSecret(correlation.emailDigest, sha256(emailKey(envelope.correlationEmail)))) candidates.add(correlation.subjectId);
        else reason = "CORRELATION_RECIPIENT_MISMATCH_OR_EXPIRED";
      }
      const manualMatch = event.subjectId && event.processingMode === "REPLAY" && await tx.trackingAudit.findFirst({ where: { eventId: event.id, action: "MANUAL_MATCH" } });
      if (manualMatch) candidates.clear();
      if (event.subjectId) candidates.add(event.subjectId); // An audited manual match affects this receipt, never another identity.
      if (candidates.size > 1) return tx.trackingEvent.update({ where: { id: event.id }, data: { status: "UNMATCHED", reason: "AMBIGUOUS_BUSINESS_REFERENCES", processedAt: this.now() } });
      let subject = candidates.size ? await tx.funnelSubject.findUnique({ where: { id: [...candidates][0] } }) : null;
      if (!subject && event.visitorId && envelope.authority === "BROWSER_OBSERVED") {
        const identified = await tx.trackingEvent.findMany({ where: { sourceId: source.id, visitorId: event.visitorId, type: "enquiry.accepted", status: "MATCHED" }, select: { subjectId: true }, take: 20 });
        const subjects = [...new Set(identified.map(e => e.subjectId).filter(Boolean))];
        if (subjects.length === 1) subject = await tx.funnelSubject.findUnique({ where: { id: subjects[0]! } });
        reason = subjects.length > 1 ? "AMBIGUOUS_ANONYMOUS_VISIT" : "ANONYMOUS_OBSERVATION";
      }
      if (!subject && (!envelope.createsSubject || envelope.authority === "BROWSER_OBSERVED"))
        return tx.trackingEvent.update({ where: { id: event.id }, data: { status: "UNMATCHED", reason, processedAt: this.now() } });
      if (subject && (subject.ownerId !== event.ownerId || subject.environment !== event.environment || subject.kind !== kind && envelope.authority !== "BROWSER_OBSERVED"))
        return tx.trackingEvent.update({ where: { id: event.id }, data: { status: "QUARANTINED", reason: "SUBJECT_BOUNDARY_MISMATCH", processedAt: this.now() } });
      // Receipt-only manual choices cannot copy canonical money to a different business subject.
      const selectedSubjectId = subject?.id;
      if (selectedSubjectId && envelope.factKey && mappings.some(mapping => mapping.subjectId !== selectedSubjectId))
        return tx.trackingEvent.update({ where: { id: event.id }, data: { status: "UNMATCHED", reason: "FINANCIAL_REFERENCE_CONFLICT", processedAt: this.now() } });
      for (const ref of refs.filter(ref => ref.kind === "ORDER")) {
        const multipleOrders = refs.some(other => other.kind === "ORDER" && other.sourceId === ref.sourceId && other.id !== ref.id);
        const otherOrder = subject && await tx.funnelSubjectReference.findFirst({ where: { sourceId: ref.sourceId, subjectId: subject.id, kind: "ORDER", externalId: { not: ref.id } } });
        const boundElsewhere = selectedSubjectId && mappings.some(mapping => mapping.sourceId === ref.sourceId && mapping.kind === "ORDER" && mapping.externalId === ref.id && mapping.subjectId !== selectedSubjectId);
        if (multipleOrders || otherOrder || boundElsewhere) return tx.trackingEvent.update({ where: { id: event.id }, data: { status: "UNMATCHED", reason: "ORDER_REFERENCE_CONFLICT", processedAt: this.now() } });
      }
      // Resolve identity even when a business reference already found a subject. Never merge by email.
      const incomingIdentity = envelope.contactIdentity;
      let identity: { contactId: string } | null = null;
      if (incomingIdentity) {
        const deleted = await tx.trackingDeletion.findUnique({ where: { ownerId_sourceId_namespace_externalIdDigest: {
          ownerId: source.ownerId, sourceId: source.id, namespace: `CONTACT:${incomingIdentity.kind}`, externalIdDigest: sha256(incomingIdentity.id) } } });
        if (deleted) return tx.trackingEvent.update({ where: { id: event.id }, data: { status: "REDACTED", envelope: {}, reason: "DELETED_CONTACT", processedAt: this.now() } });
        identity = await tx.funnelIdentity.findUnique({ where: { ownerId_sourceId_namespace_externalId: {
          ownerId: source.ownerId, sourceId: source.id, namespace: incomingIdentity.kind, externalId: incomingIdentity.id } } });
      }
      if (subject?.contactId && identity && subject.contactId !== identity.contactId)
        return tx.trackingEvent.update({ where: { id: event.id }, data: { status: "QUARANTINED", reason: "CONTACT_IDENTITY_CONFLICT", processedAt: this.now() } });
      let contactId = subject?.contactId ?? identity?.contactId ?? undefined;
      const contact = contactId ? await tx.funnelContact.findUnique({ where: { id: contactId } }) : null;
      if (contact?.deletedAt)
        return tx.trackingEvent.update({ where: { id: event.id }, data: { status: "REDACTED", envelope: {}, reason: "DELETED_CONTACT", processedAt: this.now() } });
      if (contact && (contact.ownerId !== event.ownerId || contact.environment !== event.environment))
        return tx.trackingEvent.update({ where: { id: event.id }, data: { status: "QUARANTINED", reason: "CONTACT_BOUNDARY_MISMATCH", processedAt: this.now() } });
      if (contact?.email && envelope.contact?.email && emailKey(contact.email) !== emailKey(envelope.contact.email))
        return tx.trackingEvent.update({ where: { id: event.id }, data: { status: "QUARANTINED", reason: "CONTACT_RECIPIENT_CONFLICT", processedAt: this.now() } });
      const existingFact = subject && envelope.factKey && envelope.authority !== "BROWSER_OBSERVED" ?
        await tx.trackingFact.findUnique({ where: { ownerId_subjectId_key: { ownerId: source.ownerId, subjectId: subject.id, key: envelope.factKey } } }) : null;
      if (existingFact) {
        const oldMoney = existingFact.attributes as Record<string, unknown>;
        const moneyChanged = ["amount", "currency", "presentmentAmount", "presentmentCurrency"].some(key =>
          oldMoney[key] !== undefined && envelope.properties[key] !== undefined && oldMoney[key] !== envelope.properties[key]);
        if (moneyChanged) {
          await tx.trackingAudit.create({ data: { ownerId: source.ownerId, environment: source.environment, sourceId: source.id, eventId: event.id,
            action: "FINANCIAL_FACT_CONFLICT", reason: "Conflicting monetary evidence requires explicit reconciliation; existing canonical fact retained." } });
          return tx.trackingEvent.update({ where: { id: event.id }, data: { status: "QUARANTINED", reason: "FINANCIAL_FACT_CONFLICT", subjectId: subject!.id, contactId: subject!.contactId, processedAt: this.now() } });
        }
      }
      // All conflict/deletion/generation checks precede new contact, identity or alias writes.
      if (!contactId && (incomingIdentity || envelope.contact?.email || envelope.contact?.name)) {
        const created = await tx.funnelContact.create({ data: { ownerId: source.ownerId, environment: source.environment,
          email: envelope.contact?.email, name: envelope.contact?.name } }); contactId = created.id;
      }
      if (!subject) subject = await tx.funnelSubject.create({ data: { ownerId: source.ownerId, environment: source.environment, kind, contactId } });
      else if (!subject.contactId && contactId) subject = await tx.funnelSubject.update({ where: { id: subject.id }, data: { contactId } });
      if (incomingIdentity && !identity && contactId) {
        await tx.funnelIdentity.create({ data: { ownerId: source.ownerId, environment: source.environment, sourceId: source.id,
          namespace: incomingIdentity.kind, externalId: incomingIdentity.id, contactId } });
        await tx.trackingAudit.create({ data: { ownerId: source.ownerId, environment: source.environment, sourceId: source.id, eventId: event.id,
          action: "IDENTITY_BOUND", reason: `Bound authenticated source identity; source=${source.id}; generation=${event.sourceGeneration}; kind=${incomingIdentity.kind}. No email-based merge.` } });
      }
      if (envelope.authority !== "BROWSER_OBSERVED") for (const ref of refs) {
        const prior = mappings.find(mapping => mapping.sourceId === ref.sourceId && mapping.kind === ref.kind && mapping.externalId === ref.id);
        await tx.funnelSubjectReference.upsert({ where: { ownerId_sourceId_kind_externalId: { ownerId: source.ownerId, sourceId: ref.sourceId, kind: ref.kind, externalId: ref.id } },
          create: { ownerId: source.ownerId, environment: source.environment, sourceId: ref.sourceId, subjectId: subject.id, kind: ref.kind, externalId: ref.id }, update: {} });
        if (ref.sourceGeneration !== undefined && (!prior || prior.subjectId === subject.id) && !await tx.trackingAudit.findFirst({ where: { eventId: event.id, action: "API_HANDOFF_REFERENCE", reason: `Server-asserted association; source=${ref.sourceId}; generation=${ref.sourceGeneration}; kind=${ref.kind}. Provider namespace is not payment or booking verification.` } }))
          await tx.trackingAudit.create({ data: { ownerId: source.ownerId, environment: source.environment, sourceId: source.id, eventId: event.id,
            action: "API_HANDOFF_REFERENCE", reason: `Server-asserted association; source=${ref.sourceId}; generation=${ref.sourceGeneration}; kind=${ref.kind}. Provider namespace is not payment or booking verification.` } });
      }
      let factId: string | undefined;
      if (envelope.factKey && envelope.authority !== "BROWSER_OBSERVED") {
        const fact = existingFact ?? await tx.trackingFact.create({ data: { ownerId: source.ownerId, environment: source.environment, subjectId: subject.id, key: envelope.factKey,
          type: event.type, authority: envelope.authority, occurredAt: event.occurredAt, attributes: jsonValue(envelope.properties) } });
        factId = fact.id;
        if (JSON.stringify(fact.attributes) !== JSON.stringify(jsonValue(envelope.properties)))
          await tx.trackingAudit.create({ data: { ownerId: source.ownerId, environment: source.environment, sourceId: source.id, eventId: event.id,
            action: "FACT_EVIDENCE_DIFFERENCE", reason: "Existing canonical fact retained; reconcile differing evidence before changing financial totals." } });
      }
      const late = !!subject.lastOccurredAt && event.occurredAt < subject.lastOccurredAt;
      if (!late) await tx.funnelSubject.update({ where: { id: subject.id }, data: { lastOccurredAt: event.occurredAt } });
      const result = await tx.trackingEvent.update({ where: { id: event.id }, data: { status: "MATCHED", reason: null,
        subjectId: subject.id, contactId: subject.contactId, factId, late, processedAt: this.now() } });
      await enqueueFunnelEvaluation(tx, result, this.now());
      if (event.visitorId && event.type === "enquiry.accepted") {
        // Only earlier anonymous observations are linked. Recovery is measurement-only.
        // Persist a bounded-query repair queue; the matcher commits each page and receipt separately.
        await tx.trackingEvent.updateMany({ where: { sourceId: source.id, visitorId: event.visitorId, status: "UNMATCHED", type: { in: browserTypes }, occurredAt: { lte: event.occurredAt } },
          data: { subjectId: subject.id, contactId: subject.contactId, status: "QUEUED", reason: "IDENTIFIED_BY_ACCEPTED_FORM", processingMode: "REPLAY" } });
      }
      return result;
    });
  }
  async match(principal: CustomerPrincipal, sourceId: string, eventId: string, value: unknown) {
    await this.auth.assertSession(principal); const input = object(value); fields(input, ["subjectId", "reason"]);
    const subjectId = text(input.subjectId), reason = text(input.reason, 500);
    await this.db.$transaction(async tx => {
      await this.session(tx, principal); const source = await this.owned(tx, principal, sourceId);
      if (source.provider === "RESEND") fail("MANAGED_EMAIL_SOURCE", 409, "Email evidence must match its persisted message send.");
      const event = await tx.trackingEvent.findFirst({ where: { id: eventId, sourceId, ownerId: principal.userId, status: "UNMATCHED" } });
      const subject = await tx.funnelSubject.findFirst({ where: { id: subjectId, ownerId: principal.userId, environment: source.environment } });
      if (!event || !subject) fail("NOT_FOUND", 404, "Unmatched event or compatible subject not found.");
      const envelope = event.envelope as unknown as NormalizedTrackingEvent;
      const kind = envelope.subjectKind ?? (event.type.startsWith("booking.") ? "SALES" : event.type.startsWith("refund.") ? "PURCHASE" : "CONTACT");
      if (subject.kind !== kind && envelope.authority !== "BROWSER_OBSERVED") fail("INVALID_MATCH", 400, "Choose the matching sales, purchase or contact subject kind.");
      await tx.trackingEvent.update({ where: { id: event.id }, data: { subjectId, status: "QUEUED", processingMode: "REPLAY" } });
      await tx.trackingAudit.create({ data: { ownerId: source.ownerId, environment: source.environment, sourceId, eventId,
        actorId: principal.userId, action: "MANUAL_MATCH", reason } });
    }); return { queued: true, processingMode: "REPLAY" };
  }
  async replay(principal: CustomerPrincipal, sourceId: string, eventId: string) {
    await this.auth.assertSession(principal);
    await this.db.$transaction(async tx => {
      await this.session(tx, principal); const source = await this.owned(tx, principal, sourceId); this.usable(source);
      if (source.provider === "RESEND") fail("MANAGED_EMAIL_SOURCE", 409, "Reconcile email history through its persisted send.");
      const event = await tx.trackingEvent.findFirst({ where: { id: eventId, sourceId, ownerId: principal.userId } });
      if (!event || ["REDACTED", "QUARANTINED"].includes(event.status)) fail("REPLAY_UNAVAILABLE", 409, "Redacted or quarantined evidence cannot be replayed. Reconcile the source instead.");
      await tx.trackingEvent.update({ where: { id: eventId }, data: { status: "QUEUED", processingMode: "REPLAY" } });
      await tx.trackingAudit.create({ data: { ownerId: source.ownerId, environment: source.environment, sourceId, eventId, actorId: principal.userId,
        action: "HISTORY_REPLAY", reason: "Explicit history-only replay; cannot create new external actions." } });
    }); return { queued: true, processingMode: "REPLAY" };
  }
  async reconcile(principal: CustomerPrincipal, sourceId: string, value: unknown, fetcher?: typeof fetch) {
    await this.auth.assertSession(principal); const source = await this.owned(this.db, principal, sourceId); this.usable(source);
    if (source.provider === "RESEND") fail("MANAGED_EMAIL_SOURCE", 409, "Reconcile a persisted email send through its original connection.");
    const input = object(value); fields(input, ["kind", "id"]);
    const kind = text(input.kind), id = text(input.id, 500);
    if (!["BOOKING", "ORDER", "REFUND"].includes(kind)) fail("INVALID_TRACKING_INPUT", 400, "Choose an explicit booking, order or refund.");
    await this.rate(source);
    try {
      const receipt = await reconcileProviderResource(this.adapterSource(source), this.credentials(source), { kind, id } as ReconcileResource, this.now(), fetcher);
      return await this.accept(source, receipt.events, receipt.rawPayloadDigest, "BACKFILL", undefined, principal);
    } catch (error) {
      await this.db.trackingAudit.create({ data: { ownerId: source.ownerId, environment: source.environment, sourceId, actorId: principal.userId,
        action: "RECONCILIATION_FAILED", reason: "Provider record could not be verified; no state or financial outcome inferred." } });
      throw error;
    }
  }
  async audit(principal: CustomerPrincipal, sourceId: string) {
    await this.auth.assertSession(principal); await this.owned(this.db, principal, sourceId);
    return this.db.trackingAudit.findMany({ where: { ownerId: principal.userId, sourceId }, orderBy: { createdAt: "desc" }, take: 100,
      select: { id: true, eventId: true, action: true, reason: true, actorId: true, createdAt: true } });
  }
  async prune() {
    return this.db.$transaction(async tx => {
      const result = await tx.trackingEvent.updateMany({ where: { expiresAt: { lt: this.now() }, status: { in: ["UNMATCHED", "QUARANTINED", "BLOCKED"] } },
        data: { envelope: {}, status: "REDACTED", reason: "RETENTION_EXPIRED" } });
      await tx.trackingCorrelation.deleteMany({ where: { expiresAt: { lt: this.now() } } });
      // Keep event/digest tombstones. A queued evaluator or active journey still pins its evidence.
      const eligible = await tx.trackingEvent.findMany({ where: { expiresAt: { lt: this.now() }, status: "MATCHED",
        evaluationReceipts: { none: { status: { in: ["PENDING", "FAILED"] } } },
        OR: [{ subjectId: null }, { subject: { journeys: { none: { status: "ACTIVE" } },
          campaignMemberships: { none: { endedAt: null, stepExecutions: { some: {} } } } } }] }, select: { id: true }, take: 250 });
      let matchedRedacted = 0;
      for (const event of eligible) {
        await tx.trackingEvent.update({ where: { id: event.id }, data: { envelope: {}, status: "REDACTED", reason: "RETENTION_EXPIRED" } });
        matchedRedacted++;
      }
      return { redacted: result.count + matchedRedacted };
    });
  }
  async deleteContact(principal: CustomerPrincipal, contactId: string) {
    await this.auth.assertSession(principal);
    await this.db.$transaction(async tx => {
      await this.session(tx, principal);
      const contact = await tx.funnelContact.findFirst({ where: { id: contactId, ownerId: principal.userId } });
      if (!contact) fail("NOT_FOUND", 404, "Contact not found.");
      await eraseEmailContact(tx, contactId, this.now());
      const identities = await tx.funnelIdentity.findMany({ where: { contactId } });
      for (const identity of identities) await tx.trackingDeletion.upsert({ where: { ownerId_sourceId_namespace_externalIdDigest: {
        ownerId: contact.ownerId, sourceId: identity.sourceId, namespace: `CONTACT:${identity.namespace}`, externalIdDigest: sha256(identity.externalId) } },
        create: { ownerId: contact.ownerId, environment: contact.environment, sourceId: identity.sourceId, namespace: `CONTACT:${identity.namespace}`, externalIdDigest: sha256(identity.externalId) }, update: {} });
      await tx.funnelIdentity.deleteMany({ where: { contactId } });
      const subjects = await tx.funnelSubject.findMany({ where: { contactId }, select: { id: true } });
      const subjectIds = subjects.map(s => s.id);
      await eraseFunnelSubjects(tx, subjectIds, this.now());
      const references = await tx.funnelSubjectReference.findMany({ where: { subjectId: { in: subjectIds } } });
      for (const ref of references) await tx.trackingDeletion.upsert({ where: { ownerId_sourceId_namespace_externalIdDigest: {
        ownerId: contact.ownerId, sourceId: ref.sourceId, namespace: `SUBJECT:${ref.kind}`, externalIdDigest: sha256(ref.externalId) } },
        create: { ownerId: contact.ownerId, environment: contact.environment, sourceId: ref.sourceId, namespace: `SUBJECT:${ref.kind}`, externalIdDigest: sha256(ref.externalId) }, update: {} });
      const correlations = await tx.trackingCorrelation.findMany({ where: { subjectId: { in: subjectIds } }, select: { sourceId: true, tokenHash: true } });
      const affectedSources = [...new Set([...identities, ...references, ...correlations].map(record => record.sourceId))];
      const identityKeys = new Set(identities.map(i => JSON.stringify([i.sourceId, i.namespace, i.externalId])));
      const referenceKeys = new Set(references.map(r => JSON.stringify([r.sourceId, r.kind, r.externalId])));
      const correlationKeys = new Set(correlations.map(c => JSON.stringify([c.sourceId, c.tokenHash])));
      let cursor: string | undefined;
      while (affectedSources.length) {
        // A signed handoff can arrive through an API source with no existing binding to this contact.
        const unresolved = await tx.trackingEvent.findMany({ where: { ownerId: contact.ownerId, environment: contact.environment,
          ...(cursor ? { id: { gt: cursor } } : {}), status: { in: ["QUEUED", "UNMATCHED", "BLOCKED", "QUARANTINED"] } }, orderBy: { id: "asc" }, take: 250 });
        if (!unresolved.length) break;
        for (const pending of unresolved) {
          const e = pending.envelope as unknown as NormalizedTrackingEvent;
          const knownIdentity = e.contactIdentity && identityKeys.has(JSON.stringify([pending.sourceId, e.contactIdentity.kind, e.contactIdentity.id]));
          const knownReference = [e.resource, ...e.references].some(ref => referenceKeys.has(JSON.stringify([(ref as BusinessReference).sourceId ?? pending.sourceId, ref.kind, ref.id])));
          const knownCorrelation = e.correlationToken && correlationKeys.has(JSON.stringify([pending.sourceId, sha256(e.correlationToken)]));
          if (knownIdentity || knownReference || knownCorrelation) await tx.trackingEvent.update({ where: { id: pending.id },
            data: { status: "REDACTED", envelope: {}, reason: "CONTACT_DELETED", contactId: null } });
        }
        cursor = unresolved.at(-1)!.id;
      }
      const facts = await tx.trackingFact.findMany({ where: { subjectId: { in: subjectIds } } });
      for (const fact of facts) {
        const attrs = fact.attributes as Record<string, unknown>;
        const retained = Object.fromEntries(["amount", "currency", "presentmentAmount", "presentmentCurrency"].filter(key => attrs[key] !== undefined).map(key => [key, attrs[key]]));
        await tx.trackingFact.update({ where: { id: fact.id }, data: { attributes: jsonValue(retained) } });
      }
      await tx.trackingCorrelation.deleteMany({ where: { subjectId: { in: subjectIds } } });
      await tx.funnelSubjectReference.deleteMany({ where: { subjectId: { in: subjectIds } } });
      await tx.trackingEvent.updateMany({ where: { ownerId: contact.ownerId, OR: [{ contactId }, { subjectId: { in: subjectIds } }] },
        data: { status: "REDACTED", envelope: {}, reason: "CONTACT_DELETED", contactId: null } });
      await tx.funnelContact.update({ where: { id: contactId }, data: { email: null, name: null, deletedAt: this.now() } });
    }); return { deleted: true };
  }
}
