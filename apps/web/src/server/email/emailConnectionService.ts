import { randomBytes, randomUUID } from "node:crypto";
import type { Prisma, PrismaClient, EmailConnection, EmailSender } from "../../generated/prisma/client";
import type { CustomerAuth, CustomerPrincipal } from "../auth/customerAuth";
import type { CredentialVault } from "../security/credentialVault";
import { fail, SecurityError } from "../security/errors";
import { email, fields, object, sha256, text } from "../funnels/trackingValidation";
import { emailEnvironment } from "./campaignDefinition";
import { emailCredentialContext, emailJson, checkEmailEligibility } from "./emailPolicy";
import { EMAIL_SUPPORTED_EVENTS, type EmailProviderFactory } from "./emailProvider";

type Tx = Prisma.TransactionClient;
export type EmailSenderRefreshLease = Readonly<{ senderId: string; token: string }>;
const REFRESH_LEASE_MS = 120_000;
const refreshBackoff = (attempt: number) => Math.min(3_600_000, 60_000 * 2 ** Math.max(0, attempt - 1));
const senderDto = (sender: EmailSender) => ({ id: sender.id, environment: sender.environment, connectionId: sender.connectionId,
  address: sender.address, name: sender.name, replyTo: sender.replyTo, domainId: sender.domainId, status: sender.status,
  verifiedAt: sender.verifiedAt, readiness: sender.readiness, createdAt: sender.createdAt, updatedAt: sender.updatedAt,
  refreshStatus: sender.refreshStatus, refreshAttemptCount: sender.refreshAttemptCount, refreshNextAttemptAt: sender.refreshNextAttemptAt,
  refreshLastAttemptAt: sender.refreshLastAttemptAt, refreshCompletedAt: sender.refreshCompletedAt, refreshErrorCode: sender.refreshErrorCode });
export class EmailConnectionService {
  constructor(private readonly db: PrismaClient, private readonly auth: CustomerAuth, private readonly vault: CredentialVault,
    private readonly providerFor: EmailProviderFactory, private readonly origin: string, private readonly now = () => new Date(), private readonly workerOptions: { liveEnabled: boolean } = { liveEnabled: false }) {
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
      capabilities: connection.capabilities, readiness: connection.readiness, verifiedAt: connection.verifiedAt, senders: senders.map(senderDto) };
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
    const sender = await this.db.$transaction(async tx => {
      await this.session(tx, p); const connection = await this.owned(tx, p, connectionId);
      if (await tx.emailSender.count({ where: { connectionId } }) >= 20) fail("EMAIL_SENDER_LIMIT", 409, "Use up to 20 immutable sender identities per connection.");
      return tx.emailSender.create({ data: { ownerId: p.userId, environment: connection.environment, connectionId, address, name, replyTo, domainId,
        readiness: { ready: false, reason: "CHECK_REQUIRED" }, createdAt: this.now() } });
    });
    return senderDto(sender);
  }
  private async refreshAuthorityTx(tx: Tx, senderId: string, membershipId: string) {
    const eligible = await checkEmailEligibility(tx, { membershipId, now: this.now(), liveEnabled: this.workerOptions.liveEnabled, purpose: "REFRESH" });
    if (!eligible.eligible) fail(eligible.code, 409, "The membership cannot refresh email readiness.");
    const execution = await tx.campaignStepExecution.findFirst({ where: { membershipId, status: { in: ["READY", "SEND_PENDING"] }, redactedAt: null } });
    if (!execution || eligible.sender.id !== senderId || execution.expiresAt && execution.expiresAt <= this.now())
      fail("EMAIL_AUTOMATION_NOT_STARTED", 409, "No current authorized step requires this sender.");
    return eligible;
  }
  private async claimRefreshTx(tx: Tx, senderId: string, membershipId: string | null, principal?: CustomerPrincipal) {
    if (principal) await this.session(tx, principal);
    const sender = await tx.emailSender.findUniqueOrThrow({ where: { id: senderId } });
    if (principal && sender.ownerId !== principal.userId) fail("NOT_FOUND", 404, "Email sender not found.");
    const connection = await tx.emailConnection.findUniqueOrThrow({ where: { id: sender.connectionId } }),
      source = await tx.trackingSource.findUniqueOrThrow({ where: { id: connection.sourceId } });
    if (source.status !== "ACTIVE") fail("EMAIL_CONNECTION_UNAVAILABLE", 409, "Activate the connection before checking it.");
    if (membershipId) await this.refreshAuthorityTx(tx, senderId, membershipId);
    if (sender.refreshLeaseUntil && sender.refreshLeaseUntil > this.now()) return null;
    const generationChanged = sender.refreshConnectionGeneration !== source.generation || sender.refreshCredentialVersion !== connection.credentialVersion;
    const cached = sender.readiness as { ready?: boolean; generation?: number; credentialVersion?: number; checkedAt?: string };
    const age = this.now().getTime() - Date.parse(cached.checkedAt ?? "");
    if (!principal && (cached.ready && cached.generation === source.generation && cached.credentialVersion === connection.credentialVersion && age >= 0 && age <= 900_000 ||
      !generationChanged && (sender.refreshStatus === "BLOCKED" || sender.refreshAttemptCount >= 5 || sender.refreshNextAttemptAt && sender.refreshNextAttemptAt > this.now()))) return null;
    const credentials = this.credentials(connection);
    if (!connection.providerWebhookId || !connection.expectedWebhookUrlDigest || !credentials.webhookSecret || !sender.domainId)
      fail("EMAIL_SETUP_REQUIRED", 409, "Save the provider webhook ID, signing secret and sender domain before checking readiness.");
    const token = randomBytes(32).toString("base64url");
    const changed = await tx.emailSender.updateMany({ where: { id: senderId, refreshRevision: sender.refreshRevision, refreshLeaseTokenHash: sender.refreshLeaseTokenHash },
      data: { refreshStatus: "CLAIMED", refreshMembershipId: membershipId, refreshLeaseTokenHash: sha256(token), refreshLeaseUntil: new Date(this.now().getTime() + REFRESH_LEASE_MS),
        refreshConnectionGeneration: source.generation, refreshCredentialVersion: connection.credentialVersion,
        refreshAttemptCount: principal || generationChanged ? 1 : sender.refreshAttemptCount + 1, refreshLastAttemptAt: this.now(), refreshNextAttemptAt: null,
        refreshErrorCode: null, refreshRevision: { increment: 1 } } });
    return changed.count ? { senderId, token } : null;
  }
  async claimSenderRefresh(membershipId: string): Promise<EmailSenderRefreshLease | null> {
    const membership = await this.db.campaignMembership.findUnique({ where: { id: membershipId }, include: { campaignRevision: true } });
    if (!membership) return null;
    try { return await this.db.$transaction(tx => this.claimRefreshTx(tx, membership.campaignRevision.senderId, membershipId)); }
    catch (error) { if (error instanceof SecurityError && error.status < 500) return null; throw error; }
  }
  private async verifyRefreshTx(tx: Tx, lease: EmailSenderRefreshLease, principal?: CustomerPrincipal) {
    if (principal) await this.session(tx, principal);
    const sender = await tx.emailSender.findUniqueOrThrow({ where: { id: lease.senderId } });
    const connection = await tx.emailConnection.findUniqueOrThrow({ where: { id: sender.connectionId } }), source = await tx.trackingSource.findUniqueOrThrow({ where: { id: connection.sourceId } });
    if (source.status !== "ACTIVE" || sender.refreshConnectionGeneration !== source.generation || sender.refreshCredentialVersion !== connection.credentialVersion)
      fail("EMAIL_CONNECTION_CHANGED", 409, "The connection changed. Check it again.");
    if (sender.refreshStatus !== "CLAIMED" || sender.refreshLeaseTokenHash !== sha256(lease.token) || !sender.refreshLeaseUntil || sender.refreshLeaseUntil <= this.now())
      fail("EMAIL_LEASE_LOST", 409, "The sender refresh lease is no longer current.");
    if (principal) { if (sender.ownerId !== principal.userId) fail("NOT_FOUND", 404, "Email sender not found."); }
    else {
      if (!sender.refreshMembershipId) fail("EMAIL_AUTOMATION_NOT_STARTED", 409, "A worker refresh requires a persisted membership.");
      await this.refreshAuthorityTx(tx, sender.id, sender.refreshMembershipId);
    }
    return { sender, connection, source };
  }
  private async runRefresh(lease: EmailSenderRefreshLease, principal?: CustomerPrincipal) {
    try {
      const snapshot = await this.db.$transaction(tx => this.verifyRefreshTx(tx, lease, principal));
      const { sender, connection, source } = snapshot, environment = emailEnvironment(connection.environment), credentials = this.credentials(connection);
      const provider = this.providerFor(environment);
      if (provider.capabilities.environment !== environment) fail("EMAIL_MODE_MISMATCH", 500, "The email adapter does not match this environment.");
      const check = await provider.validateSender({ environment, ...credentials, beforeRequest: async operation => {
        if (operation !== "CHECK_SENDER" && operation !== "CHECK_WEBHOOK") fail("EMAIL_OPERATION_INVALID", 500, "Unexpected readiness operation.");
        await this.db.$transaction(tx => this.verifyRefreshTx(tx, lease, principal));
      } }, { address: sender.address, domainId: sender.domainId!, providerWebhookId: connection.providerWebhookId!, expectedWebhookUrlDigest: connection.expectedWebhookUrlDigest! });
      return await this.db.$transaction(async tx => {
        const current = await this.verifyRefreshTx(tx, lease, principal);
        const failed = !check.sender.ready ? check.sender : !check.webhook.ready ? check.webhook : undefined;
        const code = failed && !failed.ready ? failed.code : undefined;
        const transient = code && ["RATE_LIMITED", "PROVIDER_UNAVAILABLE", "NETWORK_UNCERTAIN", "PROVIDER_UNCERTAIN"].includes(code);
        const retry = !check.ready && transient && current.sender.refreshAttemptCount < 5;
        const readiness = emailJson({ ...check, generation: source.generation, credentialVersion: connection.credentialVersion });
        await tx.emailConnection.update({ where: { id: connection.id }, data: { capabilities: emailJson(check.capabilities), readiness, verifiedAt: check.ready ? this.now() : null } });
        return tx.emailSender.update({ where: { id: sender.id }, data: { status: check.ready ? "VERIFIED" : "UNAVAILABLE", readiness, verifiedAt: check.ready ? this.now() : null,
          refreshStatus: check.ready ? "IDLE" : retry ? "RETRY" : "BLOCKED", refreshLeaseTokenHash: null, refreshLeaseUntil: null,
          refreshAttemptCount: check.ready ? 0 : current.sender.refreshAttemptCount,
          refreshNextAttemptAt: retry ? new Date(this.now().getTime() + refreshBackoff(current.sender.refreshAttemptCount)) : null,
          refreshCompletedAt: this.now(), refreshErrorCode: code ?? null, refreshRevision: { increment: 1 } } });
      });
    } catch (error) {
      const code = error instanceof SecurityError ? error.code : "EMAIL_READINESS_UNAVAILABLE";
      await this.db.emailSender.updateMany({ where: { id: lease.senderId, refreshLeaseTokenHash: sha256(lease.token) },
        data: { refreshStatus: "RETRY", refreshLeaseTokenHash: null, refreshLeaseUntil: null, refreshErrorCode: code,
          refreshNextAttemptAt: new Date(this.now().getTime() + 60_000), refreshRevision: { increment: 1 } } });
      throw error;
    }
  }
  async refreshClaimedSender(lease: EmailSenderRefreshLease) {
    try {
      const sender = await this.runRefresh(lease);
      return { senderId: sender.id, status: sender.status === "VERIFIED" ? "READY" as const : sender.refreshStatus === "RETRY" ? "DEFERRED" as const : "BLOCKED" as const,
        code: sender.refreshErrorCode ?? undefined, nextWakeAt: sender.refreshNextAttemptAt?.toISOString() };
    } catch (error) {
      if (!(error instanceof SecurityError)) throw error;
      return { senderId: lease.senderId, status: "BLOCKED" as const, code: error.code };
    }
  }
  async recoverSenderRefreshOnce() {
    const hint = await this.db.emailSender.findFirst({ where: { refreshStatus: "CLAIMED", refreshLeaseUntil: { lte: this.now() } }, orderBy: { refreshLeaseUntil: "asc" } });
    if (!hint) return null;
    const changed = await this.db.emailSender.updateMany({ where: { id: hint.id, refreshStatus: "CLAIMED", refreshRevision: hint.refreshRevision,
      refreshLeaseTokenHash: hint.refreshLeaseTokenHash, refreshLeaseUntil: { lte: this.now() } },
      data: { refreshStatus: hint.refreshAttemptCount >= 5 ? "BLOCKED" : "RETRY", refreshLeaseTokenHash: null, refreshLeaseUntil: null,
        refreshErrorCode: "REFRESH_INTERRUPTED", refreshNextAttemptAt: new Date(this.now().getTime() + refreshBackoff(hint.refreshAttemptCount)), refreshRevision: { increment: 1 } } });
    return changed.count ? { senderId: hint.id, code: "REFRESH_INTERRUPTED" } : null;
  }
  async checkSender(p: CustomerPrincipal, senderId: string) {
    await this.auth.assertSession(p);
    if (!await this.db.emailSender.findFirst({ where: { id: senderId, ownerId: p.userId } })) fail("NOT_FOUND", 404, "Email sender not found.");
    const lease = await this.db.$transaction(tx => this.claimRefreshTx(tx, senderId, null, p));
    if (!lease) fail("EMAIL_REFRESH_IN_PROGRESS", 409, "Sender verification is already in progress.");
    return senderDto(await this.runRefresh(lease, p));
  }
  async check(p: CustomerPrincipal, id: string) {
    await this.auth.assertSession(p); await this.owned(this.db, p, id);
    const senders = await this.db.emailSender.findMany({ where: { connectionId: id }, select: { id: true }, take: 20 });
    if (!senders.length) fail("EMAIL_SENDER_REQUIRED", 409, "Add a sender before checking this connection.");
    for (const sender of senders) await this.checkSender(p, sender.id);
    return this.get(p, id);
  }
}
