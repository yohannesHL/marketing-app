import { randomUUID } from "node:crypto";
import type { Prisma, PrismaClient } from "../../generated/prisma/client";
import {
  CustomerAuth,
  digest,
  type CustomerPrincipal,
} from "../auth/customerAuth";
import { CustomerConnections, type OAuthRequest } from "./customerConnections";
import { ProviderConnectionState } from "./providerConnectionState";
import { SocialConnectionState } from "./socialConnectionState";
import {
  XClient,
  XError,
  X_SCOPES,
  type XConfig,
  type XOperation,
} from "../providers/x";
import { SocialApiBudget } from "../social/apiBudget";
import {
  fail,
  privateJson,
  readBody,
  securityResponse,
} from "../security/errors";
import { oauthBrowserFailure } from "./oauthBrowserResponse";

/** Root supplies serialized renewal; this service never independently rotates a refresh token. */
export type XConnectionRenewal = (input: {
  authorizationId: string;
  providerUserId: string;
  credentialVersion: number;
  mode: "mock" | "live";
  verifyCurrent(): Promise<void>;
  beforeBillableRequest(operation: XOperation): Promise<void>;
}) => Promise<void>;
const cap = (value: unknown) => {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)
    fail(
      "INVALID_API_COST",
      400,
      "Explicitly approve a safe integer X API cost ceiling in USD micros.",
    );
  return value;
};
export class XConnectionService {
  readonly oauth: OAuthRequest;
  constructor(
    private readonly db: PrismaClient,
    private readonly auth: CustomerAuth,
    private readonly connections: CustomerConnections,
    private readonly state: ProviderConnectionState,
    private readonly social: SocialConnectionState,
    private readonly budget: SocialApiBudget,
    private readonly config: XConfig,
    readonly mode: "mock" | "live",
    private readonly now = () => new Date(),
    private readonly renew?: XConnectionRenewal,
  ) {
    if (new XClient(config).mode !== mode)
      fail(
        "CONNECTION_MODE_MISMATCH",
        503,
        "Configure X for the current provider mode.",
      );
    this.oauth = {
      provider: "X",
      capability: "SOCIAL",
      pkce: true,
      scopes: [...X_SCOPES],
      redirectUri: `${auth.origin}/api/connections/x/callback`,
    };
    if (config.redirectUri !== this.oauth.redirectUri)
      fail(
        "INVALID_CALLBACK",
        503,
        "Configure the registered X callback on APP_ORIGIN.",
      );
  }
  async start(
    principal: CustomerPrincipal,
    maxApiCostMicros: number,
    authorizationId?: string,
  ) {
    await this.auth.assertSession(principal);
    const quote = this.budget.connectionQuote(
      principal.userId,
      this.mode,
      cap(maxApiCostMicros),
    );
    if (authorizationId) {
      const previous = await this.state.grant(
        principal,
        authorizationId,
        "X",
        "SOCIAL",
        true,
      );
      if (previous.connectionMode !== this.mode.toUpperCase())
        fail(
          "CONNECTION_MODE_MISMATCH",
          409,
          "Reconnect an X authorization in its original mode.",
        );
    }
    const attempt = await this.connections.beginOAuth(principal, {
      ...this.oauth,
      reconnectAuthorizationId: authorizationId,
    });
    const row = await this.db.oAuthAttempt.findUniqueOrThrow({
      where: { stateHash: digest(attempt.state) },
    });
    try {
      await this.db.xConnectionCostApproval.create({
        data: {
          id: randomUUID(),
          kind: "OAUTH",
          stateHash: row.stateHash,
          oauthAttemptId: row.id,
          ownerId: principal.userId,
          sessionId: principal.sessionId,
          connectionMode: this.mode.toUpperCase(),
          capMicros: BigInt(maxApiCostMicros),
          expiresAt: row.expiresAt,
          createdAt: this.now(),
        },
      });
    } catch (error) {
      await this.state.cancelOAuth(principal, attempt.state, this.oauth);
      throw error;
    }
    return {
      authorizationUrl: new XClient(this.config).authorizationUrl({
        state: attempt.state,
        codeChallenge: attempt.codeChallenge!,
      }),
      mode: this.mode,
      estimatedUserReadCostMicros: quote.userReadCostMicros,
      approvedApiCostMicros: maxApiCostMicros,
    };
  }
  private async verifyApproval(
    tx: Prisma.TransactionClient,
    principal: CustomerPrincipal,
    approvalId: string,
    claim?: string,
    allowExpired = false,
  ) {
    const session = await tx.customerSession.findFirst({
      where: {
        id: principal.sessionId,
        userId: principal.userId,
        expiresAt: { gt: this.now() },
      },
    });
    const approval = await tx.xConnectionCostApproval.findFirst({
      where: {
        id: approvalId,
        ownerId: principal.userId,
        sessionId: principal.sessionId,
        connectionMode: this.mode.toUpperCase(),
        consumedAt: null,
        expiresAt: { gt: this.now() },
      },
    });
    if (!session || !approval)
      fail(
        "API_COST_APPROVAL_REQUIRED",
        409,
        "The session-owned X cost approval is unavailable or expired.",
      );
    if (approval.kind === "OAUTH") {
      const attempt = await tx.oAuthAttempt.findFirst({
        where: {
          id: approval.oauthAttemptId!,
          stateHash: approval.stateHash!,
          userId: principal.userId,
          sessionId: principal.sessionId,
          provider: "X",
          capability: "SOCIAL",
          redirectUri: this.oauth.redirectUri,
          consumedAt: null,
          expiresAt: { gt: this.now() },
          exchangeClaimHash: claim ? digest(claim) : null,
        },
      });
      if (!attempt || !claim)
        fail(
          "INVALID_OAUTH_STATE",
          400,
          "The claimed X connection attempt is no longer current.",
        );
    } else if (approval.kind === "CONNECTION_READ") {
      const grant = await tx.providerAuthorization.findFirst({
        where: {
          id: approval.authorizationId!,
          userId: principal.userId,
          provider: "X",
          capability: "SOCIAL",
          connectionMode: this.mode.toUpperCase(),
          status: "CONNECTED",
          generation: approval.authorizationGeneration!,
          credentialVersion: approval.credentialVersion!,
        },
      });
      if (
        !grant ||
        !grant.accessCiphertext ||
        !X_SCOPES.every((scope) => (grant.scopes as string[]).includes(scope))
      )
        fail(
          "STALE_CREDENTIALS",
          409,
          "The X profile authorization changed during its access check.",
        );
      if (
        !allowExpired &&
        grant.expiresAt &&
        grant.expiresAt.getTime() <= this.now().getTime() + 60000
      )
        fail(
          "RECONNECT_REQUIRED",
          409,
          "Renew X access before checking its profile.",
        );
    } else
      fail(
        "API_COST_APPROVAL_REQUIRED",
        409,
        "This X cost approval has an unsupported purpose.",
      );
    return {
      approvalId: approval.id,
      ownerId: principal.userId,
      sessionId: principal.sessionId,
      mode: this.mode,
    };
  }
  private checkedClient(
    principal: CustomerPrincipal,
    approvalId: string,
    cost: number,
    claim?: string,
    allowExpired = false,
  ) {
    const verify = (tx: Prisma.TransactionClient) =>
      this.verifyApproval(tx, principal, approvalId, claim, allowExpired);
    const verifyCurrent = async () => {
      await this.db.$transaction(verify);
    };
    const beforeBillableRequest = async (operation: XOperation) => {
      if (operation !== "USER_READ")
        fail(
          "API_COST_APPROVAL_REQUIRED",
          403,
          "Only the approved X identity read is allowed during connection setup.",
        );
      await this.budget.reserveConnection(
        { approvalId, mode: this.mode, operation, costMicros: cost },
        verify,
      );
    };
    return {
      client: new XClient({
        ...this.config,
        beforeRequest: verifyCurrent,
        beforeBillableRequest,
      }),
      verifyCurrent,
      beforeBillableRequest,
    };
  }
  async complete(
    principal: CustomerPrincipal,
    stateValue: string,
    code?: string,
    denied = false,
    failed = false,
  ) {
    const attempt = await this.connections.claimOAuthExchange(
      principal,
      stateValue,
      this.oauth,
    );
    const approval = await this.db.xConnectionCostApproval.findUnique({
      where: { stateHash: digest(stateValue) },
    });
    try {
      if (denied) fail("CONSENT_DENIED", 400, "X permission was declined.");
      if (failed)
        fail(
          "PROVIDER_AUTHORIZATION_FAILED",
          502,
          "X could not authorize this connection. Start again.",
        );
      if (!code || code.length > 4096 || !attempt.codeVerifier)
        fail("INVALID_OAUTH_CODE", 400, "Restart the X connection.");
      if (!approval)
        fail(
          "API_COST_APPROVAL_REQUIRED",
          409,
          "Approve the X connection read cost before signing in.",
        );
      const quote = this.budget.connectionQuote(
          principal.userId,
          this.mode,
          Number(approval.capMicros),
        ),
        checked = this.checkedClient(
          principal,
          approval.id,
          quote.userReadCostMicros,
          attempt.exchangeClaimToken,
        );
      const previous = attempt.reconnectAuthorizationId
        ? await this.state.grant(
            principal,
            attempt.reconnectAuthorizationId,
            "X",
            "SOCIAL",
            true,
          )
        : undefined;
      if (previous && previous.connectionMode !== this.mode.toUpperCase())
        fail(
          "CONNECTION_MODE_MISMATCH",
          409,
          "Create a new connection when changing modes.",
        );
      const grant = await checked.client.exchangeCode({
        code,
        codeVerifier: attempt.codeVerifier,
        ...(previous
          ? { previous: { providerUserId: previous.providerUserId } }
          : {}),
      });
      const connection = await this.connections.completeAuthorization(
        principal,
        stateValue,
        this.oauth,
        {
          ...grant,
          connectionMode: this.mode.toUpperCase() as "MOCK" | "LIVE",
        },
        attempt.exchangeClaimToken,
      );
      await this.social.synchronize(
        principal,
        connection.id,
        "X",
        connection.credentialVersion,
        [
          {
            kind: "X_PROFILE",
            externalId: grant.providerUserId,
            name: `${grant.name} (@${grant.username})`,
            available: true,
            canRead: true,
            canWrite: "ALLOWED",
          },
        ],
      );
      await this.db.xConnectionCostApproval.updateMany({
        where: {
          id: approval.id,
          ownerId: principal.userId,
          sessionId: principal.sessionId,
        },
        data: { consumedAt: this.now() },
      });
      return {
        connection: await this.connections.get(principal, connection.id),
        mode: this.mode,
      };
    } catch (error) {
      await this.state
        .cancelOAuth(
          principal,
          stateValue,
          this.oauth,
          attempt.exchangeClaimToken,
        )
        .catch(() => {});
      if (approval)
        await this.db.xConnectionCostApproval.updateMany({
          where: {
            id: approval.id,
            ownerId: principal.userId,
            sessionId: principal.sessionId,
          },
          data: { consumedAt: this.now() },
        });
      throw error;
    }
  }
  async select(
    principal: CustomerPrincipal,
    id: string,
    destinationId: string,
  ) {
    const grant = await this.state.grant(principal, id, "X", "SOCIAL");
    if (grant.connectionMode !== this.mode.toUpperCase())
      fail(
        "CONNECTION_MODE_MISMATCH",
        409,
        "Choose an X connection for this mode.",
      );
    if (
      !grant.accessToken ||
      !X_SCOPES.every((scope) => grant.scopes.includes(scope)) ||
      (grant.expiresAt &&
        grant.expiresAt.getTime() <= this.now().getTime() + 60000)
    )
      fail(
        "RECONNECT_REQUIRED",
        409,
        "Renew verified X profile access before selecting it.",
      );
    const connection = await this.connections.get(principal, id);
    if (
      !connection.destinations.some(
        (d) =>
          d.id === destinationId &&
          d.kind === "X_PROFILE" &&
          d.externalId === grant.providerUserId,
      )
    )
      fail(
        "INVALID_SELECTION",
        403,
        "Choose the single profile belonging to this X authorization.",
      );
    await this.social.select(
      principal,
      id,
      "X",
      grant.credentialVersion,
      destinationId,
      this.mode,
    );
    return {
      connection: await this.connections.get(principal, id),
      mode: this.mode,
      verification: "CACHED_IDENTITY",
    };
  }
  async refresh(
    principal: CustomerPrincipal,
    id: string,
    approvedCap: number,
    destinationId?: string,
  ) {
    await this.auth.assertSession(principal);
    let grant = await this.state.grant(principal, id, "X", "SOCIAL");
    if (grant.connectionMode !== this.mode.toUpperCase())
      fail(
        "CONNECTION_MODE_MISMATCH",
        409,
        "Choose an X connection for this mode.",
      );
    if (destinationId) {
      const connection = await this.connections.get(principal, id);
      if (
        !connection.destinations.some(
          (d) =>
            d.id === destinationId &&
            d.kind === "X_PROFILE" &&
            d.externalId === grant.providerUserId,
        )
      )
        fail("NOT_FOUND", 404, "Choose an owned X profile destination.");
    }
    const quote = this.budget.connectionQuote(
        principal.userId,
        this.mode,
        cap(approvedCap),
      ),
      expired =
        !!grant.expiresAt &&
        grant.expiresAt.getTime() <= this.now().getTime() + 60000;
    if (expired && !this.renew)
      fail(
        "RECONNECT_REQUIRED",
        409,
        "Reconnect X or enable verified serialized renewal before checking this profile.",
      );
    if (expired && approvedCap < 2 * quote.userReadCostMicros)
      fail(
        "API_COST_LIMIT",
        409,
        "Approve the renewal verification and profile-read cost estimate.",
      );
    const parent = await this.db.providerAuthorization.findFirstOrThrow({
      where: {
        id,
        userId: principal.userId,
        provider: "X",
        capability: "SOCIAL",
      },
    });
    const approval = await this.db.xConnectionCostApproval.create({
      data: {
        id: randomUUID(),
        kind: "CONNECTION_READ",
        ownerId: principal.userId,
        sessionId: principal.sessionId,
        connectionMode: this.mode.toUpperCase(),
        authorizationId: id,
        authorizationGeneration: parent.generation,
        credentialVersion: grant.credentialVersion,
        capMicros: BigInt(approvedCap),
        expiresAt: new Date(this.now().getTime() + 600000),
        createdAt: this.now(),
      },
    });
    try {
      if (expired) {
        const checked = this.checkedClient(
          principal,
          approval.id,
          quote.userReadCostMicros,
          undefined,
          true,
        );
        await this.renew!({
          authorizationId: id,
          providerUserId: grant.providerUserId,
          credentialVersion: grant.credentialVersion,
          mode: this.mode,
          verifyCurrent: checked.verifyCurrent,
          beforeBillableRequest: checked.beforeBillableRequest,
        });
        grant = await this.state.grant(principal, id, "X", "SOCIAL");
        await this.db.$transaction(async (tx) => {
          const updated = await tx.providerAuthorization.findFirst({
            where: {
              id,
              userId: principal.userId,
              provider: "X",
              capability: "SOCIAL",
              generation: parent.generation,
              credentialVersion: grant.credentialVersion,
              connectionMode: this.mode.toUpperCase(),
              status: "CONNECTED",
            },
          });
          if (!updated)
            fail(
              "STALE_CREDENTIALS",
              409,
              "X changed during serialized renewal.",
            );
          await tx.xConnectionCostApproval.update({
            where: { id: approval.id },
            data: { credentialVersion: updated.credentialVersion },
          });
        });
      }
      const checked = this.checkedClient(
          principal,
          approval.id,
          quote.userReadCostMicros,
        ),
        user = await checked.client.verifiedUser(
          grant.accessToken!,
          grant.providerUserId,
        );
      await this.social.synchronize(
        principal,
        id,
        "X",
        grant.credentialVersion,
        [
          {
            kind: "X_PROFILE",
            externalId: user.id,
            name: `${user.name} (@${user.username})`,
            available: true,
            canRead: true,
            canWrite: "ALLOWED",
          },
        ],
      );
      return {
        connection: await this.connections.get(principal, id),
        mode: this.mode,
      };
    } catch (error) {
      if (
        error instanceof XError &&
        [
          "RECONNECT_REQUIRED",
          "MISSING_PERMISSION",
          "PROVIDER_IDENTITY_MISMATCH",
        ].includes(error.code)
      )
        await this.state.requireReconnect(
          principal,
          id,
          grant.credentialVersion,
        );
      throw error;
    } finally {
      await this.db.xConnectionCostApproval.updateMany({
        where: { id: approval.id },
        data: { consumedAt: this.now() },
      });
    }
  }
}
export function createXConnectionApi(
  auth: CustomerAuth,
  service: XConnectionService,
) {
  return async (request: Request) => {
    const url = new URL(request.url),
      callback = url.pathname === "/api/connections/x/callback",
      html = callback && request.headers.get("accept")?.includes("text/html");
    try {
      const principal = await auth.requireSession(request);
      if (callback && request.method === "GET") {
        const result = await service.complete(
          principal,
          url.searchParams.get("state") ?? "",
          url.searchParams.get("code") ?? undefined,
          url.searchParams.get("error") === "access_denied",
          url.searchParams.has("error") &&
            url.searchParams.get("error") !== "access_denied",
        );
        return html
          ? new Response(null, {
              status: 303,
              headers: {
                Location: `${auth.origin}/connections?provider=x&result=connected`,
                "Cache-Control": "no-store",
                "Referrer-Policy": "no-referrer",
              },
            })
          : privateJson(result);
      }
      auth.assertOrigin(request);
      if (request.method !== "POST")
        fail("METHOD_NOT_ALLOWED", 405, "Use POST for X connection actions.");
      const body = await readBody(request);
      if (url.pathname === "/api/connections/x/start") {
        if (
          Object.keys(body).some(
            (key) => !["authorizationId", "maxApiCostMicros"].includes(key),
          ) ||
          (body.authorizationId !== undefined &&
            typeof body.authorizationId !== "string")
        )
          fail(
            "INVALID_BODY",
            400,
            "Supply an explicit cost ceiling and optional X connection to reconnect.",
          );
        return privateJson(
          await service.start(
            principal,
            cap(body.maxApiCostMicros),
            body.authorizationId as string | undefined,
          ),
        );
      }
      const match = url.pathname.match(
        /^\/api\/connections\/x\/([A-Za-z0-9_-]{1,128})\/(refresh|check|select)$/,
      );
      if (!match) fail("NOT_FOUND", 404, "X connection action not found.");
      if (match[2] === "select") {
        if (
          Object.keys(body).some((key) => key !== "destinationId") ||
          typeof body.destinationId !== "string"
        )
          fail(
            "INVALID_BODY",
            400,
            "Supply the owned X destination to select.",
          );
        return privateJson(
          await service.select(principal, match[1], body.destinationId),
        );
      }
      if (
        Object.keys(body).some(
          (key) => !["maxApiCostMicros", "destinationId"].includes(key),
        ) ||
        (body.destinationId !== undefined &&
          typeof body.destinationId !== "string") ||
        (match[2] === "check" && typeof body.destinationId !== "string")
      )
        fail(
          "INVALID_BODY",
          400,
          "Supply an explicit read cost ceiling and owned destination for a check.",
        );
      return privateJson(
        await service.refresh(
          principal,
          match[1],
          cap(body.maxApiCostMicros),
          body.destinationId as string | undefined,
        ),
      );
    } catch (error) {
      return html
        ? oauthBrowserFailure(auth.origin, "x", error)
        : securityResponse(error);
    }
  };
}
