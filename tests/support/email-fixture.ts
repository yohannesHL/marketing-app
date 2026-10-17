import assert from "node:assert/strict";
import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClient } from "@libsql/client";
import { PrismaClient } from "../../apps/web/src/generated/prisma/client";
import { LocalSqliteAdapter } from "../../apps/web/src/server/prisma/localSqliteAdapter";
import { CustomerAuth, digest, type CustomerPrincipal } from "../../apps/web/src/server/auth/customerAuth";
import { CredentialVault } from "../../apps/web/src/server/security/credentialVault";
import { TrackingService } from "../../apps/web/src/server/funnels/trackingService";
import { FunnelService } from "../../apps/web/src/server/funnels/funnelService";
import type { FunnelDefinition } from "../../apps/web/src/server/funnels/funnelDefinition";
import { EmailConnectionService } from "../../apps/web/src/server/email/emailConnectionService";
import { MarketingCampaignService } from "../../apps/web/src/server/email/marketingCampaignService";
import { EmailDeliveryService } from "../../apps/web/src/server/email/emailDeliveryService";
import { createResendProvider } from "../../apps/web/src/server/email/resendProvider";
import { EMAIL_REQUIRED_EVENTS, type EmailProviderFactory } from "../../apps/web/src/server/email/emailProvider";
import type { CampaignDefinition } from "../../apps/web/src/server/email/campaignDefinition";
import { applyConnectionMigrations } from "./test-database";

export const EMAIL_FIXTURE_ORIGIN = "https://launchpad.test";
export const EMAIL_FIXTURE_SECRET = `whsec_${Buffer.alloc(32, 37).toString("base64")}`;
export type EmailFixtureRequest = { url: string; method: string; headers: Headers; body: string | null; json: Record<string, any> | null };
type Handler = (request: EmailFixtureRequest) => Response | undefined | Promise<Response | undefined>;
type Account = { domainId: string; webhookId: string; webhookUrl: string; secret: string; domain: string };

/** Isolated migrated SQLite + real public services and adapter. No global fetch or external network. */
export async function createEmailFixture() {
  const dir = await mkdtemp(join(tmpdir(), "launchpad-email-")), url = `file:${join(dir, "fixture.db")}`;
  const migration = createClient({ url });
  try { await applyConnectionMigrations(migration); } finally { migration.close(); }
  const db = new PrismaClient({ adapter: new LocalSqliteAdapter({ url }) });
  let clock = new Date("2026-10-19T10:00:00.000Z");
  const now = () => new Date(clock), setNow = (value: Date) => { assert.ok(Number.isFinite(value.getTime())); clock = new Date(value); };
  const auth = new CustomerAuth(db, { origin: EMAIL_FIXTURE_ORIGIN }, now);
  const vault = new CredentialVault({ fixture: Buffer.alloc(32, 17).toString("base64") }, "fixture");
  async function owner() {
    const id = randomUUID(), token = randomBytes(32).toString("base64url");
    await db.user.create({ data: { id, email: `${id}@example.test`, name: "Fixture owner" } });
    const session = await db.customerSession.create({ data: { userId: id, tokenHash: digest(token), expiresAt: new Date("2028-01-01T00:00:00Z") } });
    const principal: CustomerPrincipal = { userId: id, sessionId: session.id };
    return { principal, cookie: `${auth.cookieName}=${token}` };
  }
  const { principal, cookie } = await owner();
  const requests: EmailFixtureRequest[] = [], accounts = new Map<string, Account>();
  const knownEmails = new Map<string, Record<string, unknown>>(), acceptedKeys = new Map<string, { body: string; id: string }>();
  const transport: { requests: EmailFixtureRequest[]; knownEmails: typeof knownEmails; onSend?: Handler; onRetrieve?: Handler; onRequest?: Handler;
    accept: (request: EmailFixtureRequest, id?: string) => Response } = { requests, knownEmails, accept(request, id = randomUUID()) {
    assert.ok(request.json && request.body); const payload = request.json;
    knownEmails.set(id, { id, from: payload.from, to: payload.to, subject: payload.subject, html: payload.html ?? null,
      text: payload.text ?? null, reply_to: payload.reply_to ?? [], cc: [], bcc: [], created_at: now().toISOString(), last_event: "sent", tags: payload.tags });
    return Response.json({ id });
  } };
  const fakeFetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const target = new URL(String(input));
    assert.equal(target.origin, "http://127.0.0.1:3998", "Fixture cannot call a live provider");
    const body = typeof init?.body === "string" ? init.body : null;
    const request: EmailFixtureRequest = { url: target.toString(), method: init?.method ?? "GET", headers: new Headers(init?.headers), body, json: body ? JSON.parse(body) : null };
    requests.push(request);
    const override = await transport.onRequest?.(request); if (override) return override;
    const account = accounts.get(request.headers.get("authorization")?.replace(/^Bearer /, "") ?? "");
    if (!account) return Response.json({ name: "validation_error" }, { status: 401 });
    if (request.method === "GET" && target.pathname === `/domains/${account.domainId}`)
      return Response.json({ id: account.domainId, name: account.domain, status: "verified", capabilities: { sending: "enabled", receiving: "disabled" }, open_tracking: false, click_tracking: true });
    if (request.method === "GET" && target.pathname === `/webhooks/${account.webhookId}`)
      return Response.json({ id: account.webhookId, endpoint: account.webhookUrl, signing_secret: account.secret, status: "enabled", events: [...EMAIL_REQUIRED_EVENTS] });
    if (request.method === "POST" && target.pathname === "/emails") {
      const custom = await transport.onSend?.(request); if (custom) return custom;
      const key = `${request.headers.get("authorization")}:${request.headers.get("idempotency-key")}`, prior = acceptedKeys.get(key);
      if (prior) return prior.body === body ? Response.json({ id: prior.id }) : Response.json({ name: "invalid_idempotent_request" }, { status: 409 });
      const id = randomUUID(); acceptedKeys.set(key, { body: body!, id }); return transport.accept(request, id);
    }
    if (request.method === "GET" && target.pathname.startsWith("/emails/")) {
      const custom = await transport.onRetrieve?.(request); if (custom) return custom;
      const email = knownEmails.get(target.pathname.slice(8)); return email ? Response.json(email) : Response.json({ name: "not_found" }, { status: 404 });
    }
    return Response.json({ name: "not_found" }, { status: 404 });
  }) as typeof fetch;
  const testProvider = createResendProvider({ environment: "TEST", fixture: { origin: "http://127.0.0.1:3998", fetch: fakeFetch }, now });
  const liveProvider = createResendProvider({ environment: "LIVE", liveEnabled: false, fetch: async () => { throw new Error("Live transport is forbidden in the fixture"); }, now });
  const providerFor: EmailProviderFactory = environment => environment === "TEST" ? testProvider : liveProvider;
  const tracking = new TrackingService(db, auth, vault, now), funnels = new FunnelService(db, auth, now);
  const connections = new EmailConnectionService(db, auth, vault, providerFor, EMAIL_FIXTURE_ORIGIN, now);
  const campaigns = new MarketingCampaignService(db, auth, now, false);
  const delivery = new EmailDeliveryService(db, auth, vault, providerFor, { now, liveEnabled: false, unsubscribeBaseUrl: `${EMAIL_FIXTURE_ORIGIN}/unsubscribe` });

  async function readyConnection(p = principal) {
    const apiKey = `fixture_${randomUUID()}`, domainId = randomUUID(), webhookId = randomUUID();
    const created = await connections.create(p, { name: "Fixture Resend", environment: "TEST", apiKey });
    const account = { domainId, webhookId, webhookUrl: created.webhookUrl, secret: EMAIL_FIXTURE_SECRET, domain: "example.test" };
    accounts.set(apiKey, account);
    await connections.update(p, created.connection.id, { webhookSecret: account.secret, providerWebhookId: webhookId });
    const sender = await connections.createSender(p, created.connection.id, { address: "hello@example.test", name: "Fixture team", domainId });
    const verified = await connections.checkSender(p, sender.id); assert.equal(verified.status, "VERIFIED");
    return { connection: await connections.get(p, created.connection.id), sender: verified, apiKey, domainId, webhookId,
      webhookUrl: created.webhookUrl, ingressToken: new URL(created.webhookUrl).pathname.split("/").at(-1)!, secret: account.secret, account };
  }
  const sourceByOwner = new Map<string, Awaited<ReturnType<TrackingService["createSource"]>>["source"]>();
  const signingSecret = "email-fixture-api-signing-secret";
  async function recipient(options: { principal?: CustomerPrincipal; email?: string; contactExternalId?: string; subjectExternalId?: string } = {}) {
    const p = options.principal ?? principal;
    let source = sourceByOwner.get(p.userId);
    if (!source) {
      source = (await tracking.createSource(p, { name: "Fixture CRM", provider: "API", environment: "TEST", externalAccountId: randomUUID(),
        credentials: { signingSecret }, config: { allowedEvents: ["enquiry.accepted"], propertyKeys: [] } })).source;
      sourceByOwner.set(p.userId, source);
    }
    const contactExternalId = options.contactExternalId ?? randomUUID(), subjectExternalId = options.subjectExternalId ?? randomUUID();
    const raw = JSON.stringify({ schemaVersion: 1, type: "enquiry.accepted", occurredAt: now().toISOString(), resource: { kind: "ENQUIRY", id: subjectExternalId },
      subjectKind: "SALES", contactIdentity: { kind: "CRM_CONTACT", id: contactExternalId }, contact: { email: options.email ?? "maya@example.test" }, properties: {} });
    const time = String(now().getTime() / 1000), id = randomUUID();
    const accepted = await tracking.collectApi(source.id, new Headers({ "x-launchpad-id": id, "x-launchpad-timestamp": time,
      "x-launchpad-signature": createHmac("sha256", signingSecret).update(`${time}.${id}.${raw}`).digest("hex") }), raw);
    await tracking.processOnce();
    const event = await db.trackingEvent.findUniqueOrThrow({ where: { id: accepted.receipts[0].id } });
    assert.ok(event.subjectId && event.contactId);
    return { source, event, contact: await db.funnelContact.findUniqueOrThrow({ where: { id: event.contactId } }),
      subject: await db.funnelSubject.findUniqueOrThrow({ where: { id: event.subjectId } }), contactExternalId, subjectExternalId };
  }
  function definition(senderId: string, subscriptionCategory = "consultation"): CampaignDefinition {
    return { schemaVersion: 1, senderId, subscriptionCategory, timeZone: "UTC",
      sendWindow: { timeZone: "UTC", weekdays: [1, 2, 3, 4, 5], startMinute: 540, endMinute: 1020 },
      steps: [{ id: "intro", subject: "Your consultation", text: "Thank you for your enquiry.", html: "<p>Thank you for your enquiry.</p>", wait: { kind: "IMMEDIATE" }, expiresAfterDueSeconds: 604800 }] };
  }
  async function publishedCampaign(options: { principal?: CustomerPrincipal; setup?: Awaited<ReturnType<typeof readyConnection>>; membershipScope?: "SUBJECT" | "CONTACT"; category?: string; definition?: CampaignDefinition } = {}) {
    const p = options.principal ?? principal, setup = options.setup ?? await readyConnection(p), draft = options.definition ?? definition(setup.sender.id, options.category);
    const campaign = await campaigns.create(p, { name: "Consultation follow-up", environment: "TEST", membershipScope: options.membershipScope ?? "SUBJECT", definition: draft });
    const { revision } = await campaigns.publish(p, campaign.id, { draftRevision: campaign.draftRevision });
    await campaigns.controls(p, campaign.id, { enrolmentEnabled: true, dispatchEnabled: true });
    const step = await db.campaignStep.findFirstOrThrow({ where: { revisionId: revision.id } });
    return { setup, campaign, revision, step, definition: draft };
  }
  async function consent(contactId: string, category = "consultation", p = principal) {
    return campaigns.updatePolicy(p, { contactId, category, action: "OPT_IN", reason: "Recipient explicitly requested this category", requestKey: randomUUID(),
      provenance: { source: "fixture-consent-form", purpose: category, observedAt: now().toISOString() } });
  }
  async function manualJourney(subjectId: string, campaignId?: string, p = principal) {
    const definition: FunnelDefinition = { schemaVersion: 1, stages: [{ id: "lead", name: "Lead", goal: false, terminal: "NONE" }], entryStages: ["lead"], routes: [],
      ...(campaignId ? { campaignLinks: [{ id: "attribution", stageId: "lead", campaignId, purpose: "ATTRIBUTION" as const }] } : {}) };
    const funnel = await funnels.create(p, { name: "Consultation journey", environment: "TEST", subjectKind: "SALES", definition });
    const publication = await funnels.publish(p, funnel.id, { draftRevision: 1 });
    const moved = await funnels.move(p, funnel.id, { subjectId, stageId: "lead", reason: "Manually confirmed enquiry", commandKey: randomUUID() });
    return { funnel, publication, ...moved };
  }
  async function enrolled(options: { principal?: CustomerPrincipal; recipient?: Awaited<ReturnType<typeof recipient>>; published?: Awaited<ReturnType<typeof publishedCampaign>>;
    setup?: Awaited<ReturnType<typeof readyConnection>>; membershipScope?: "SUBJECT" | "CONTACT"; category?: string; journey?: boolean } = {}) {
    const p = options.principal ?? principal, person = options.recipient ?? await recipient({ principal: p });
    const published = options.published ?? await publishedCampaign({ principal: p, setup: options.setup, membershipScope: options.membershipScope, category: options.category });
    await consent(person.contact.id, published.definition.subscriptionCategory, p);
    const moved = options.journey === false ? undefined : await manualJourney(person.subject.id, published.campaign.id, p);
    const command = { ...(published.campaign.membershipScope === "CONTACT" ? { contactId: person.contact.id } : { subjectId: person.subject.id }),
      ...(moved ? { journeyId: moved.journey.id } : {}), requestKey: randomUUID(), reason: "Requested consultation follow-up" };
    const enrolment = await campaigns.enrol(p, published.campaign.id, command);
    return { ...person, ...published, ...enrolment, command, journey: moved?.journey, funnel: moved?.funnel };
  }
  function signWebhook(payload: unknown, options: { secret?: string; deliveryId?: string; time?: string; raw?: string } = {}) {
    const raw = options.raw ?? JSON.stringify(payload), time = options.time ?? String(now().getTime() / 1000), deliveryId = options.deliveryId ?? `msg_${randomUUID()}`;
    const signature = createHmac("sha256", Buffer.from((options.secret ?? EMAIL_FIXTURE_SECRET).slice(6), "base64")).update(`${deliveryId}.${time}.${raw}`).digest("base64");
    return { rawBody: Buffer.from(raw), headers: new Headers({ "svix-id": deliveryId, "svix-timestamp": time, "svix-signature": `v1,${signature}` }), deliveryId };
  }
  return { db, auth, vault, principal, cookie, providerFor, connections, campaigns, delivery, tracking, funnels, now, setNow,
    transport, requests, knownEmails, owner, readyConnection, recipient, definition, publishedCampaign, consent, manualJourney, enrolled, signWebhook,
    close: async () => { await db.$disconnect(); await rm(dir, { recursive: true, force: true }); } };
}
export type EmailFixture = Awaited<ReturnType<typeof createEmailFixture>>;
