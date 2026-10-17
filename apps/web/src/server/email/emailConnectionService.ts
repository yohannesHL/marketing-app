import { randomBytes, randomUUID } from "node:crypto";
import type { Prisma, PrismaClient, EmailConnection } from "../../generated/prisma/client";
import type { CustomerAuth, CustomerPrincipal } from "../auth/customerAuth";
import type { CredentialVault } from "../security/credentialVault";
import { fail } from "../security/errors";
import { email, fields, object, sha256, text } from "../funnels/trackingValidation";
import { emailEnvironment } from "./campaignDefinition";
import { emailCredentialContext, emailJson } from "./emailPolicy";
import { EMAIL_SUPPORTED_EVENTS, type EmailProviderFactory } from "./emailProvider";

type Tx = Prisma.TransactionClient;
export class EmailConnectionService {
  constructor(private readonly db: PrismaClient, private readonly auth: CustomerAuth, private readonly vault: CredentialVault,
    private readonly providerFor: EmailProviderFactory, private readonly origin: string, private readonly now = () => new Date()) {
    const url = new URL(origin);
    if (url.origin !== origin || url.username || url.password || url.protocol !== "https:" && !["localhost", "127.0.0.1"].includes(url.hostname))
      fail("INVALID_EMAIL_CONFIG", 503, "Configure an exact public HTTPS application origin.");
  }
  private async session(tx: Tx, p: CustomerPrincipal) {
    if (!await tx.customerSession.findFirst({ where: { id: p.sessionId, userId: p.userId, expiresAt: { gt: this.now() } } }))
      fail("UNAUTHENTICATED", 401, "Sign in to continue.");
  }
  private async owned(tx: Tx | PrismaClient, p: CustomerPrincipal, id: string) {
    const connection = await tx.emailConnection.findFirst({ where: { id, ownerId: p.userId } });
    if (!connection) fail("NOT_FOUND", 404, "Email connection not found."); return connection;
  }
  private credentials(connection: EmailConnection): { apiKey: string; webhookSecret: string } {
    return JSON.parse(this.vault.decrypt(connection.credentialCiphertext, emailCredentialContext(connection)));
  }
  private async dto(connection: EmailConnection) {
    const source = await this.db.trackingSource.findUniqueOrThrow({ where: { id: connection.sourceId } });
    const senders = await this.db.emailSender.findMany({ where: { connectionId: connection.id }, orderBy: { createdAt: "asc" }, take: 20 });
    return { id: connection.id, sourceId: source.id, name: source.name, provider: connection.provider, environment: connection.environment,
      status: source.status, generation: source.generation, credentialsSaved: true, webhookConfigured: !!connection.providerWebhookId,
      capabilities: connection.capabilities, readiness: connection.readiness, verifiedAt: connection.verifiedAt, senders };
  }
  async list(p: CustomerPrincipal, environment: string) {
    await this.auth.assertSession(p); emailEnvironment(environment);
    return Promise.all((await this.db.emailConnection.findMany({ where: { ownerId: p.userId, environment }, orderBy: { createdAt: "desc" }, take: 20 })).map(c => this.dto(c)));
  }
  async get(p: CustomerPrincipal, id: string) { await this.auth.assertSession(p); return this.dto(await this.owned(this.db, p, id)); }
  async create(p: CustomerPrincipal, value: unknown) {
    await this.auth.assertSession(p); const input = object(value); fields(input, ["name", "environment", "apiKey"]);
    const environment = emailEnvironment(input.environment), name = text(input.name, 120), apiKey = text(input.apiKey, 4096);
    if (environment === "LIVE" && new URL(this.origin).protocol !== "https:")
      fail("EMAIL_HTTPS_REQUIRED", 409, "Live email requires a public HTTPS origin for callbacks and unsubscribe links.");
    const id = randomUUID(), sourceId = randomUUID(), token = randomBytes(32).toString("base64url"), webhookUrl = `${this.origin}/api/email/hooks/${token}`;
    const connection = await this.db.$transaction(async tx => {
      await this.session(tx, p);
      if (await tx.emailConnection.count({ where: { ownerId: p.userId, environment } }) >= 20)
        fail("EMAIL_CONNECTION_LIMIT", 409, "Use up to 20 email connections per environment.");
      await tx.trackingSource.create({ data: { id: sourceId, ownerId: p.userId, environment, name, provider: "RESEND",
        externalAccountId: `email-connection:${id}`, ingressTokenHash: sha256(token), credentialCiphertext: null,
        config: emailJson({ allowedOrigins: [], allowedEvents: EMAIL_SUPPORTED_EVENTS.filter(type => type.startsWith("email.")),
          propertyKeys: ["deliveryState", "campaignId", "campaignRevisionId", "sendId", "stepId"] }), createdAt: this.now() } });
      return tx.emailConnection.create({ data: { id, ownerId: p.userId, environment, sourceId,
        credentialCiphertext: this.vault.encrypt(JSON.stringify({ apiKey, webhookSecret: "" }), emailCredentialContext({ id, ownerId: p.userId, environment })),
        expectedWebhookUrlDigest: sha256(webhookUrl), capabilities: {}, readiness: { ready: false, reason: "WEBHOOK_SETUP_REQUIRED" }, createdAt: this.now() } });
    });
    return { connection: await this.dto(connection), webhookUrl };
  }
  async update(p: CustomerPrincipal, id: string, value: unknown) {
    await this.auth.assertSession(p); const input = object(value); fields(input, ["apiKey", "webhookSecret", "providerWebhookId", "status", "rotateIngress"]);
    if (input.status !== undefined && !["ACTIVE", "PAUSED", "DISCONNECTED"].includes(String(input.status)) || input.rotateIngress !== undefined && input.rotateIngress !== true)
      fail("INVALID_EMAIL_INPUT", 400, "Choose a supported connection operation.");
    const token = input.rotateIngress ? randomBytes(32).toString("base64url") : undefined;
    const webhookUrl = token ? `${this.origin}/api/email/hooks/${token}` : undefined;
    const connection = await this.db.$transaction(async tx => {
      await this.session(tx, p); const previous = await this.owned(tx, p, id), credentials = this.credentials(previous);
      if (input.apiKey !== undefined) credentials.apiKey = text(input.apiKey, 4096);
      if (input.webhookSecret !== undefined) {
        credentials.webhookSecret = text(input.webhookSecret, 4096);
        if (!/^whsec_[A-Za-z0-9+/]+={0,2}$/.test(credentials.webhookSecret) || Buffer.from(credentials.webhookSecret.slice(6), "base64").length < 16)
          fail("INVALID_EMAIL_INPUT", 400, "Supply the provider webhook signing secret.");
      }
      await tx.trackingSource.update({ where: { id: previous.sourceId }, data: { status: input.status as string | undefined,
        generation: { increment: 1 }, ...(token ? { ingressTokenHash: sha256(token) } : {}) } });
      await tx.emailSender.updateMany({ where: { connectionId: id }, data: { status: "UNVERIFIED", verifiedAt: null, readiness: { ready: false, reason: "CONNECTION_CHANGED" } } });
      return tx.emailConnection.update({ where: { id }, data: {
        ...(input.apiKey !== undefined || input.webhookSecret !== undefined ? { credentialCiphertext: this.vault.encrypt(JSON.stringify(credentials), emailCredentialContext(previous)), credentialVersion: { increment: 1 } } : {}),
        ...(input.providerWebhookId === undefined ? {} : { providerWebhookId: text(input.providerWebhookId, 128) }),
        ...(webhookUrl ? { expectedWebhookUrlDigest: sha256(webhookUrl) } : {}), verifiedAt: null,
        readiness: { ready: false, reason: "RECHECK_REQUIRED" } } });
    });
    return { connection: await this.dto(connection), ...(webhookUrl ? { webhookUrl } : {}) };
  }
  async createSender(p: CustomerPrincipal, connectionId: string, value: unknown) {
    await this.auth.assertSession(p); const input = object(value); fields(input, ["address", "name", "replyTo", "domainId"]);
    const address = email(input.address), name = input.name === undefined ? undefined : text(input.name, 150),
      replyTo = input.replyTo === undefined ? undefined : email(input.replyTo), domainId = text(input.domainId, 128);
    return this.db.$transaction(async tx => {
      await this.session(tx, p); const connection = await this.owned(tx, p, connectionId);
      if (await tx.emailSender.count({ where: { connectionId } }) >= 20) fail("EMAIL_SENDER_LIMIT", 409, "Use up to 20 immutable sender identities per connection.");
      return tx.emailSender.create({ data: { ownerId: p.userId, environment: connection.environment, connectionId, address, name, replyTo, domainId,
        readiness: { ready: false, reason: "CHECK_REQUIRED" }, createdAt: this.now() } });
    });
  }
  async checkSender(p: CustomerPrincipal, senderId: string) {
    await this.auth.assertSession(p);
    const sender = await this.db.emailSender.findFirst({ where: { id: senderId, ownerId: p.userId } });
    if (!sender) fail("NOT_FOUND", 404, "Email sender not found.");
    const connection = await this.owned(this.db, p, sender.connectionId), source = await this.db.trackingSource.findUniqueOrThrow({ where: { id: connection.sourceId } });
    const credentials = this.credentials(connection);
    if (!connection.providerWebhookId || !connection.expectedWebhookUrlDigest || !credentials.webhookSecret || !sender.domainId)
      fail("EMAIL_SETUP_REQUIRED", 409, "Save the provider webhook ID, signing secret and sender domain before checking readiness.");
    if (source.status !== "ACTIVE") fail("EMAIL_CONNECTION_UNAVAILABLE", 409, "Activate the connection before checking it.");
    const environment = emailEnvironment(connection.environment), provider = this.providerFor(environment);
    const check = await provider.validateSender({ environment, ...credentials, beforeRequest: async () => {
      await this.db.$transaction(async tx => {
        await this.session(tx, p);
        if (!await tx.trackingSource.findFirst({ where: { id: source.id, ownerId: p.userId, generation: source.generation, status: "ACTIVE" } }) ||
          !await tx.emailConnection.findFirst({ where: { id: connection.id, credentialVersion: connection.credentialVersion } }))
          fail("EMAIL_CONNECTION_CHANGED", 409, "The connection changed. Check it again.");
      });
    } }, { address: sender.address, domainId: sender.domainId, providerWebhookId: connection.providerWebhookId, expectedWebhookUrlDigest: connection.expectedWebhookUrlDigest });
    return this.db.$transaction(async tx => {
      await this.session(tx, p);
      if (!await tx.trackingSource.findFirst({ where: { id: source.id, ownerId: p.userId, generation: source.generation, status: "ACTIVE" } }))
        fail("EMAIL_CONNECTION_CHANGED", 409, "The connection changed. Check it again.");
      const readiness = emailJson({ ...check, generation: source.generation, credentialVersion: connection.credentialVersion });
      await tx.emailConnection.update({ where: { id: connection.id }, data: { capabilities: emailJson(check.capabilities), readiness,
        verifiedAt: check.ready ? this.now() : null } });
      return tx.emailSender.update({ where: { id: senderId }, data: { status: check.ready ? "VERIFIED" : "UNAVAILABLE", readiness, verifiedAt: check.ready ? this.now() : null } });
    });
  }
  async check(p: CustomerPrincipal, id: string) {
    await this.auth.assertSession(p); await this.owned(this.db, p, id);
    const senders = await this.db.emailSender.findMany({ where: { connectionId: id }, select: { id: true }, take: 20 });
    if (!senders.length) fail("EMAIL_SENDER_REQUIRED", 409, "Add a sender before checking this connection.");
    for (const sender of senders) await this.checkSender(p, sender.id);
    return this.get(p, id);
  }
}
