import { prisma } from "../prisma/client";
import { customerAuth, customerConnections } from "../security/runtime";
import { CredentialVault } from "../security/credentialVault";
import { fail, securityResponse } from "../security/errors";
import type { XConfig, XOperation } from "../providers/x";
import {
  SocialApiBudget,
  type ApiBudgetOwnerPolicy,
} from "../social/apiBudget";
import { ProviderConnectionState } from "./providerConnectionState";
import { SocialConnectionState } from "./socialConnectionState";
import {
  XConnectionService,
  createXConnectionApi,
  type XConnectionRenewal,
} from "./xConnectionApi";
import { oauthBrowserFailure } from "./oauthBrowserResponse";

import { renewXPublishing } from "./xRenewal";
import { SocialProviderFailure } from "../social/types";

export function xApiBudgetPolicies(
  environment: NodeJS.ProcessEnv = process.env,
): ApiBudgetOwnerPolicy[] {
  let value: unknown;
  try {
    value = JSON.parse(environment.X_API_OWNER_BUDGETS ?? "[]");
  } catch {
    fail(
      "API_COST_APPROVAL_REQUIRED",
      503,
      "Configure explicit X owner and mode API cost allowances.",
    );
  }
  if (
    !Array.isArray(value) ||
    value.length > 1000 ||
    value.some(
      (item) =>
        !item ||
        typeof item !== "object" ||
        Array.isArray(item) ||
        Object.keys(item).some(
          (key) =>
            ![
              "ownerId",
              "mode",
              "dailyLimitMicros",
              "deliveryLimitMicros",
              "operationCeilings",
            ].includes(key),
        ),
    )
  )
    fail(
      "API_COST_APPROVAL_REQUIRED",
      503,
      "Configure supported X owner API cost allowances.",
    );
  return value as ApiBudgetOwnerPolicy[];
}
export function xProviderConfig(
  beforeRequest?: () => Promise<void>,
  beforeBillableRequest?: (operation: XOperation) => Promise<void>,
): XConfig {
  const mode = process.env.CONNECTION_MODE;
  if (mode !== "mock" && mode !== "live")
    fail("PROVIDER_DISABLED", 503, "Configure an explicit X provider mode.");
  if (mode === "mock" && !process.env.X_MOCKOON_URL)
    fail("INVALID_CONFIG", 503, "Configure the local X Mockoon API.");
  return {
    clientId: mode === "mock" ? "x-client" : (process.env.X_CLIENT_ID ?? ""),
    clientSecret:
      mode === "mock"
        ? "fixture-x-secret"
        : (process.env.X_CLIENT_SECRET ?? ""),
    redirectUri: `${customerAuth().origin}/api/connections/x/callback`,
    ...(mode === "mock"
      ? { mockoonEnabled: true, mockoonBaseUrl: process.env.X_MOCKOON_URL }
      : {}),
    ...(beforeRequest ? { beforeRequest } : {}),
    ...(beforeBillableRequest ? { beforeBillableRequest } : {}),
  };
}
export function xConnectionService(renew: XConnectionRenewal = async request => {
  await request.verifyCurrent();
  const row = await prisma.providerAuthorization.findUnique({ where: { id: request.authorizationId } });
  if (!row || row.provider !== "X" || row.capability !== "SOCIAL" || row.providerUserId !== request.providerUserId ||
    row.connectionMode.toLowerCase() !== request.mode) fail("STALE_CREDENTIALS", 409, "The X authorization changed.");
  try { await renewXPublishing(prisma, CredentialVault.fromEnvironment(), xProviderConfig(), {
    ownerId: row.userId, authorizationId: row.id, generation: row.generation, credentialVersion: request.credentialVersion,
    verifyCurrent: request.verifyCurrent, prefundUserRead: () => request.beforeBillableRequest("USER_READ"),
  }); } catch (error) {
    if (error instanceof SocialProviderFailure && error.definitive && ["RATE_LIMIT", "TRANSIENT"].includes(error.kind))
      fail("PROVIDER_RATE_LIMITED", 429, "Publishing access is being renewed. Wait briefly before checking again.");
    throw error;
  }
}) {
  const auth = customerAuth();
  return new XConnectionService(
    prisma,
    auth,
    customerConnections(),
    new ProviderConnectionState(
      prisma,
      auth,
      CredentialVault.fromEnvironment(),
    ),
    new SocialConnectionState(prisma, auth),
    new SocialApiBudget(prisma, xApiBudgetPolicies()),
    xProviderConfig(),
    process.env.CONNECTION_MODE as "mock" | "live",
    () => new Date(),
    renew,
  );
}
export async function handleXConnectionApi(request: Request) {
  let origin: string | undefined;
  try {
    const auth = customerAuth();
    origin = auth.origin;
    await auth.requireSession(request);
    return await createXConnectionApi(auth, xConnectionService())(request);
  } catch (error) {
    return origin &&
      new URL(request.url).pathname === "/api/connections/x/callback" &&
      request.headers.get("accept")?.includes("text/html")
      ? oauthBrowserFailure(origin, "x", error)
      : securityResponse(error);
  }
}
