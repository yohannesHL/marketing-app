import { createHash, randomBytes, randomUUID } from "node:crypto";
import type {
  ConnectionCapability,
  DestinationKind,
  Platform,
  Prisma,
  PrismaClient,
} from "../../generated/prisma/client";
import {
  CustomerAuth,
  digest,
  type CustomerPrincipal,
} from "../auth/customerAuth";
import { CredentialVault } from "../security/credentialVault";
import { fail } from "../security/errors";

export type OAuthRequest = {
  provider: Platform;
  capability: ConnectionCapability;
  redirectUri: string;
  scopes: string[];
  pkce: boolean;
};

export type ProviderGrant = {
  providerUserId: string;
  accessToken: string;
  refreshToken?: string;
  scopes: string[];
  expiresAt?: Date | null;
  externalGrantId?: string;
};

export type DestinationInput = {
  externalId: string;
  kind: DestinationKind;
  name?: string;
  currency?: string;
  timezone?: string;
};

export type OperationCredentials = {
  userId: string;
  provider: Platform;
  capability: ConnectionCapability;
  authorizationId: string;
  credentialVersion: number;
  externalId: string;
  kind: DestinationKind;
  accessToken: string;
  refreshToken?: string;
  expiresAt: Date | null;
};

const publicAuthorization = {
  id: true,
  provider: true,
  providerUserId: true,
  capability: true,
  scopes: true,
  status: true,
  expiresAt: true,
  createdAt: true,
  updatedAt: true,
  disconnectedAt: true,
  destinations: {
    select: {
      id: true,
      externalId: true,
      kind: true,
      name: true,
      currency: true,
      timezone: true,
      selected: true,
    },
  },
} satisfies Prisma.ProviderAuthorizationSelect;

export function credentialContext(
  userId: string,
  authorizationId: string,
  field: "access" | "refresh",
) {
  return JSON.stringify(["grant-v1", userId, authorizationId, field]);
}

function scopes(value: string[]) {
  if (
    !Array.isArray(value) ||
    value.length > 100 ||
    value.some(
      (scope) => typeof scope !== "string" || !scope || scope.length > 512,
    )
  ) {
    fail("INVALID_SCOPES", 400, "Supply a valid list of permissions.");
  }
  return [...new Set(value)].sort();
}

function validateGrant(grant: ProviderGrant) {
  if (
    !grant.providerUserId ||
    grant.providerUserId.length > 512 ||
    !grant.accessToken ||
    grant.accessToken.length > 32768 ||
    (grant.refreshToken !== undefined &&
      (!grant.refreshToken || grant.refreshToken.length > 32768)) ||
    (grant.expiresAt && !Number.isFinite(grant.expiresAt.getTime()))
  ) {
    fail("INVALID_GRANT", 400, "The provider authorization is incomplete.");
  }
  scopes(grant.scopes);
}

export class CustomerConnections {
  constructor(
    private readonly db: PrismaClient,
    private readonly auth: CustomerAuth,
    private readonly vault: CredentialVault,
    private readonly now = () => new Date(),
  ) {}

  // Provider modules choose scopes, redirect URI and PKCE support on the server.
  async beginOAuth(principal: CustomerPrincipal, input: OAuthRequest) {
    await this.auth.assertSession(principal);
    if (
      !["GOOGLE", "META", "TIKTOK", "LINKEDIN", "X"].includes(input.provider) ||
      !["ADS", "SOCIAL"].includes(input.capability) ||
      typeof input.pkce !== "boolean"
    ) {
      fail(
        "INVALID_OAUTH_CONFIG",
        400,
        "Choose a supported provider, capability and PKCE policy.",
      );
    }
    const uri = new URL(input.redirectUri);
    if (
      uri.origin !== this.auth.origin ||
      uri.username ||
      uri.password ||
      uri.search ||
      uri.hash ||
      !uri.pathname.startsWith("/api/connections/")
    ) {
      fail(
        "INVALID_CALLBACK",
        400,
        "The callback must be a registered connection route on APP_ORIGIN.",
      );
    }
    const state = randomBytes(32).toString("base64url");
    const verifier = input.pkce
      ? randomBytes(32).toString("base64url")
      : undefined;
    const id = randomUUID();
    const expiresAt = new Date(this.now().getTime() + 10 * 60 * 1000);
    await this.db.oAuthAttempt.create({
      data: {
        id,
        stateHash: digest(state),
        userId: principal.userId,
        sessionId: principal.sessionId,
        provider: input.provider,
        capability: input.capability,
        redirectUri: uri.href,
        requestedScopes: scopes(input.scopes),
        expiresAt,
        verifierCiphertext: verifier
          ? this.vault.encrypt(verifier, `oauth:${principal.userId}:${id}`)
          : null,
      },
    });
    return {
      state,
      expiresAt,
      codeChallenge: verifier
        ? createHash("sha256").update(verifier).digest("base64url")
        : undefined,
      codeChallengeMethod: verifier ? ("S256" as const) : undefined,
    };
  }

  private async oauthAttempt(
    principal: CustomerPrincipal,
    state: string,
    expected: OAuthRequest,
  ) {
    await this.auth.assertSession(principal);
    const attempt = await this.db.oAuthAttempt.findFirst({
      where: {
        stateHash: digest(state),
        userId: principal.userId,
        sessionId: principal.sessionId,
        provider: expected.provider,
        capability: expected.capability,
        redirectUri: expected.redirectUri,
        consumedAt: null,
        expiresAt: { gt: this.now() },
      },
    });
    if (!attempt)
      fail(
        "INVALID_OAUTH_STATE",
        400,
        "The connection attempt is invalid or expired. Start again.",
      );
    return attempt;
  }

  // Server-only exchange context. Never serialize this return value to a browser.
  async getOAuthExchangeContext(
    principal: CustomerPrincipal,
    state: string,
    expected: OAuthRequest,
  ) {
    const attempt = await this.oauthAttempt(principal, state, expected);
    return {
      redirectUri: attempt.redirectUri,
      requestedScopes: attempt.requestedScopes as string[],
      codeVerifier: attempt.verifierCiphertext
        ? this.vault.decrypt(
            attempt.verifierCiphertext,
            `oauth:${principal.userId}:${attempt.id}`,
          )
        : undefined,
    };
  }

  // grant must be the verified provider response, never a client-supplied token body.
  async completeAuthorization(
    principal: CustomerPrincipal,
    state: string,
    expected: OAuthRequest,
    grant: ProviderGrant,
  ) {
    validateGrant(grant);
    const attempt = await this.oauthAttempt(principal, state, expected);
    const now = this.now();
    return this.db.$transaction(async (tx) => {
      const consumed = await tx.oAuthAttempt.updateMany({
        where: {
          id: attempt.id,
          consumedAt: null,
          expiresAt: { gt: now },
          session: { userId: principal.userId, expiresAt: { gt: now } },
        },
        data: { consumedAt: now, verifierCiphertext: null },
      });
      if (consumed.count !== 1)
        fail(
          "INVALID_OAUTH_STATE",
          400,
          "The connection attempt is invalid or expired. Start again.",
        );
      const unique = {
        userId: principal.userId,
        provider: expected.provider,
        providerUserId: grant.providerUserId,
        capability: expected.capability,
      };
      const existing = await tx.providerAuthorization.findUnique({
        where: { userId_provider_providerUserId_capability: unique },
      });
      const id = existing?.id ?? randomUUID();
      const data = {
        accessCiphertext: this.vault.encrypt(
          grant.accessToken,
          credentialContext(principal.userId, id, "access"),
        ),
        refreshCiphertext: grant.refreshToken
          ? this.vault.encrypt(
              grant.refreshToken,
              credentialContext(principal.userId, id, "refresh"),
            )
          : existing?.status === "CONNECTED"
            ? existing.refreshCiphertext
            : null,
        scopes: scopes(grant.scopes),
        expiresAt: grant.expiresAt ?? null,
        externalGrantId:
          grant.externalGrantId ?? existing?.externalGrantId ?? null,
        status: "CONNECTED" as const,
        disconnectedAt: null,
      };
      await tx.providerAuthorization.upsert({
        where: { userId_provider_providerUserId_capability: unique },
        create: { id, ...unique, ...data },
        update: {
          ...data,
          generation: { increment: 1 },
          credentialVersion: { increment: 1 },
        },
      });
      if (existing)
        await tx.connectionOperation.updateMany({
          where: { destination: { authorizationId: id }, status: "PENDING" },
          data: { status: "CANCELLED", completedAt: now },
        });
      await tx.connectionAuditEvent.create({
        data: {
          authorizationId: id,
          action: existing ? "RECONNECTED" : "CONNECTED",
        },
      });
      return tx.providerAuthorization.findUniqueOrThrow({
        where: { id },
        select: publicAuthorization,
      });
    });
  }

  async list(principal: CustomerPrincipal) {
    await this.auth.assertSession(principal);
    const grants = await this.db.providerAuthorization.findMany({
      where: { userId: principal.userId },
      select: publicAuthorization,
      orderBy: { createdAt: "asc" },
    });
    return grants.map((grant) => ({
      ...grant,
      status:
        grant.status === "CONNECTED" &&
        grant.expiresAt &&
        grant.expiresAt <= this.now()
          ? ("RECONNECT_REQUIRED" as const)
          : grant.status,
    }));
  }

  async get(principal: CustomerPrincipal, id: string) {
    await this.auth.assertSession(principal);
    const authorization = await this.db.providerAuthorization.findFirst({
      where: { id, userId: principal.userId },
      select: publicAuthorization,
    });
    if (!authorization) fail("NOT_FOUND", 404, "Connection not found.");
    return {
      ...authorization,
      status:
        authorization.status === "CONNECTED" &&
        authorization.expiresAt &&
        authorization.expiresAt <= this.now()
          ? ("RECONNECT_REQUIRED" as const)
          : authorization.status,
    };
  }

  // Provider discovery registers destinations; the browser may only select these records.
  async registerDestination(
    principal: CustomerPrincipal,
    authorizationId: string,
    input: DestinationInput,
  ) {
    const authorization = await this.get(principal, authorizationId);
    const kinds: Record<Platform, DestinationKind[]> = {
      GOOGLE: ["YOUTUBE_CHANNEL"],
      META: ["FACEBOOK_PAGE", "INSTAGRAM_PROFILE"],
      TIKTOK: ["TIKTOK_PROFILE"],
      LINKEDIN: ["LINKEDIN_MEMBER", "LINKEDIN_ORGANIZATION"],
      X: ["X_PROFILE"],
    };
    if (
      !input.externalId ||
      input.externalId.length > 512 ||
      (authorization.capability === "ADS"
        ? input.kind !== "AD_ACCOUNT"
        : !kinds[authorization.provider].includes(input.kind)) ||
      [input.name, input.currency, input.timezone].some(
        (value) =>
          value !== undefined &&
          (typeof value !== "string" || value.length > 200),
      )
    ) {
      fail(
        "INVALID_DESTINATION",
        400,
        "The destination does not match this connection.",
      );
    }
    if (authorization.status !== "CONNECTED")
      fail(
        "RECONNECT_REQUIRED",
        409,
        "Reconnect before selecting destinations.",
      );
    return this.db.connectionDestination.upsert({
      where: {
        authorizationId_kind_externalId: {
          authorizationId,
          kind: input.kind,
          externalId: input.externalId,
        },
      },
      create: { authorizationId, ...input },
      update: {
        name: input.name,
        currency: input.currency,
        timezone: input.timezone,
      },
      select: publicAuthorization.destinations.select,
    });
  }

  private async ownedDestination(principal: CustomerPrincipal, id: string) {
    await this.auth.assertSession(principal);
    const destination = await this.db.connectionDestination.findFirst({
      where: { id, authorization: { userId: principal.userId } },
      include: { authorization: true },
    });
    if (!destination) fail("NOT_FOUND", 404, "Destination not found.");
    return destination;
  }

  async selectDestination(
    principal: CustomerPrincipal,
    id: string,
    selected: boolean,
  ) {
    const destination = await this.ownedDestination(principal, id);
    if (selected && destination.authorization.status !== "CONNECTED")
      fail(
        "RECONNECT_REQUIRED",
        409,
        "Reconnect before selecting destinations.",
      );
    return this.db.$transaction(async (tx) => {
      const updated = await tx.connectionDestination.updateMany({
        where: {
          id,
          authorization: {
            userId: principal.userId,
            ...(selected ? { status: "CONNECTED" as const } : {}),
          },
        },
        data: { selected },
      });
      if (!updated.count)
        fail(
          "RECONNECT_REQUIRED",
          409,
          "Reconnect before selecting destinations.",
        );
      if (!selected)
        await tx.connectionOperation.updateMany({
          where: { destinationId: id, status: { in: ["PENDING", "RUNNING"] } },
          data: { status: "CANCELLED", completedAt: this.now() },
        });
      return tx.connectionDestination.findUniqueOrThrow({
        where: { id },
        select: publicAuthorization.destinations.select,
      });
    });
  }

  async disconnect(principal: CustomerPrincipal, id: string) {
    await this.get(principal, id);
    await this.disable([id], "DISCONNECTED");
    return this.get(principal, id);
  }

  // Called only after provider callback/signature verification by the provider module.
  async markProviderRevoked(provider: Platform, externalGrantId: string) {
    if (!externalGrantId)
      fail(
        "INVALID_GRANT",
        400,
        "A verified provider grant identifier is required.",
      );
    const grants = await this.db.providerAuthorization.findMany({
      where: { provider, externalGrantId },
      select: { id: true },
    });
    await this.disable(
      grants.map((grant) => grant.id),
      "REVOKED",
    );
  }

  private async disable(ids: string[], status: "DISCONNECTED" | "REVOKED") {
    await this.db.$transaction(async (tx) => {
      const grants = await tx.providerAuthorization.findMany({
        where: { id: { in: ids } },
        select: { userId: true, provider: true, capability: true },
      });
      // The provider identity is not known until exchange completes. Cancel all
      // earlier attempts for these customer/provider/capability boundaries,
      // including attempts from other sessions, without affecting Social/Ads peers.
      if (grants.length)
        await tx.oAuthAttempt.updateMany({
          where: { consumedAt: null, OR: grants },
          data: { consumedAt: this.now(), verifierCiphertext: null },
        });
      await tx.providerAuthorization.updateMany({
        where: { id: { in: ids } },
        data: {
          status,
          accessCiphertext: null,
          refreshCiphertext: null,
          expiresAt: null,
          disconnectedAt: this.now(),
          generation: { increment: 1 },
          credentialVersion: { increment: 1 },
        },
      });
      await tx.connectionDestination.updateMany({
        where: { authorizationId: { in: ids } },
        data: { selected: false },
      });
      await tx.connectionOperation.updateMany({
        where: {
          destination: { authorizationId: { in: ids } },
          status: { in: ["PENDING", "RUNNING"] },
        },
        data: { status: "CANCELLED", completedAt: this.now() },
      });
      for (const id of ids)
        await tx.connectionAuditEvent.create({
          data: { authorizationId: id, action: status },
        });
    });
  }

  private assertUsable(
    authorization: {
      status: string;
      accessCiphertext: string | null;
      scopes: unknown;
      expiresAt: Date | null;
    },
    required: string[],
  ) {
    if (
      authorization.status !== "CONNECTED" ||
      !authorization.accessCiphertext ||
      (authorization.expiresAt && authorization.expiresAt <= this.now())
    ) {
      fail(
        "RECONNECT_REQUIRED",
        409,
        "Renew or reconnect this authorization before continuing.",
      );
    }
    const granted = authorization.scopes as string[];
    if (required.some((scope) => !granted.includes(scope)))
      fail(
        "MISSING_PERMISSION",
        403,
        "This connection lacks a required permission.",
      );
  }

  async queueOperation(
    principal: CustomerPrincipal,
    destinationId: string,
    capability: ConnectionCapability,
    requiredScopes: string[],
  ) {
    const required = scopes(requiredScopes);
    const destination = await this.ownedDestination(principal, destinationId);
    if (destination.authorization.capability !== capability)
      fail(
        "WRONG_CAPABILITY",
        403,
        "This destination does not authorize the requested marketing category.",
      );
    if (!destination.selected)
      fail(
        "DESTINATION_NOT_SELECTED",
        409,
        "Select the destination before continuing.",
      );
    this.assertUsable(destination.authorization, required);
    return this.db.$transaction(async (tx) => {
      const current = await tx.connectionDestination.findFirst({
        where: {
          id: destinationId,
          selected: true,
          authorization: {
            userId: principal.userId,
            status: "CONNECTED",
            generation: destination.authorization.generation,
          },
        },
        include: { authorization: true },
      });
      if (!current)
        fail(
          "OPERATION_UNAVAILABLE",
          409,
          "The connection changed. Create a new operation.",
        );
      this.assertUsable(current.authorization, required);
      return tx.connectionOperation.create({
        data: {
          destinationId,
          generation: current.authorization.generation,
          requiredScopes: required,
        },
      });
    });
  }

  // Trusted worker entry point. Credentials exist only inside the provider callback.
  async runOperation<T>(
    id: string,
    invoke: (credentials: OperationCredentials) => Promise<T>,
  ): Promise<T> {
    const operation = await this.db.connectionOperation.findUnique({
      where: { id },
      include: { destination: { include: { authorization: true } } },
    });
    if (!operation || operation.status !== "PENDING")
      fail(
        "OPERATION_UNAVAILABLE",
        409,
        "The operation is no longer available.",
      );
    const { destination } = operation;
    const authorization = destination.authorization;
    if (
      !destination.selected ||
      authorization.generation !== operation.generation
    )
      fail(
        "OPERATION_UNAVAILABLE",
        409,
        "The connection changed. Create a new operation.",
      );
    this.assertUsable(authorization, operation.requiredScopes as string[]);
    const claimed = await this.db.connectionOperation.updateMany({
      where: {
        id,
        status: "PENDING",
        destination: {
          selected: true,
          authorization: {
            status: "CONNECTED",
            generation: operation.generation,
          },
        },
      },
      data: { status: "RUNNING" },
    });
    if (claimed.count !== 1)
      fail(
        "OPERATION_UNAVAILABLE",
        409,
        "The operation is no longer available.",
      );
    try {
      // Re-read after claiming: cached credentials must not resurrect disconnected access.
      const checked = await this.db.connectionOperation.findUniqueOrThrow({
        where: { id },
        include: { destination: { include: { authorization: true } } },
      });
      if (checked.status !== "RUNNING" || !checked.destination.selected)
        fail(
          "OPERATION_UNAVAILABLE",
          409,
          "The operation is no longer available.",
        );
      const current = checked.destination.authorization;
      this.assertUsable(current, operation.requiredScopes as string[]);
      if (current.generation !== operation.generation)
        fail(
          "OPERATION_UNAVAILABLE",
          409,
          "The connection changed. Create a new operation.",
        );
      const result = await invoke({
        userId: current.userId,
        provider: current.provider,
        capability: current.capability,
        authorizationId: current.id,
        credentialVersion: current.credentialVersion,
        externalId: destination.externalId,
        kind: destination.kind,
        expiresAt: current.expiresAt,
        accessToken: this.vault.decrypt(
          current.accessCiphertext!,
          credentialContext(current.userId, current.id, "access"),
        ),
        refreshToken: current.refreshCiphertext
          ? this.vault.decrypt(
              current.refreshCiphertext,
              credentialContext(current.userId, current.id, "refresh"),
            )
          : undefined,
      });
      await this.db.connectionOperation.updateMany({
        where: { id, status: "RUNNING" },
        data: { status: "SUCCEEDED", completedAt: this.now() },
      });
      return result;
    } catch {
      await this.db.connectionOperation.updateMany({
        where: { id, status: "RUNNING" },
        data: { status: "FAILED", completedAt: this.now() },
      });
      // Never return an arbitrary provider exception containing a credential or request URL.
      fail(
        "OPERATION_FAILED",
        502,
        "The provider operation failed. Check connection status before retrying.",
      );
    }
  }

  async renewAuthorization(
    principal: CustomerPrincipal,
    id: string,
    exchange: (context: {
      provider: Platform;
      refreshToken: string;
    }) => Promise<Omit<ProviderGrant, "providerUserId" | "externalGrantId">>,
  ) {
    await this.auth.assertSession(principal);
    const current = await this.db.providerAuthorization.findFirst({
      where: { id, userId: principal.userId },
    });
    if (!current) fail("NOT_FOUND", 404, "Connection not found.");
    if (current.status !== "CONNECTED" || !current.refreshCiphertext)
      fail("RECONNECT_REQUIRED", 409, "Reconnect this authorization.");
    let renewed: Omit<ProviderGrant, "providerUserId" | "externalGrantId">;
    try {
      renewed = await exchange({
        provider: current.provider,
        refreshToken: this.vault.decrypt(
          current.refreshCiphertext,
          credentialContext(current.userId, id, "refresh"),
        ),
      });
    } catch {
      fail(
        "RENEWAL_FAILED",
        502,
        "The provider could not renew authorization. Reconnect if access was revoked.",
      );
    }
    await this.updateCredentials(id, current.credentialVersion, renewed);
    return this.get(principal, id);
  }

  // Refresh modules must use a snapshot/version so a late refresh cannot undo disconnect.
  async updateCredentials(
    id: string,
    expectedVersion: number,
    grant: Omit<ProviderGrant, "providerUserId" | "externalGrantId">,
  ) {
    validateGrant({ ...grant, providerUserId: "refresh" });
    const current = await this.db.providerAuthorization.findUnique({
      where: { id },
    });
    if (!current || current.status !== "CONNECTED")
      fail("RECONNECT_REQUIRED", 409, "Reconnect before renewing credentials.");
    const updated = await this.db.providerAuthorization.updateMany({
      where: { id, credentialVersion: expectedVersion, status: "CONNECTED" },
      data: {
        accessCiphertext: this.vault.encrypt(
          grant.accessToken,
          credentialContext(current.userId, id, "access"),
        ),
        refreshCiphertext: grant.refreshToken
          ? this.vault.encrypt(
              grant.refreshToken,
              credentialContext(current.userId, id, "refresh"),
            )
          : current.refreshCiphertext,
        scopes: scopes(grant.scopes),
        expiresAt: grant.expiresAt ?? null,
        credentialVersion: { increment: 1 },
      },
    });
    if (updated.count !== 1)
      fail("STALE_CREDENTIALS", 409, "Authorization changed during renewal.");
  }
}
