import type { PlatformUserAccount } from "@launchpad/core";
import type { CustomerPrincipal } from "../../auth/customerAuth";
import { customerConnections } from "../../security/runtime";
import { fail } from "../../security/errors";

// Never read legacy plaintext account columns or hand a bulk credential list to callers.
export async function withCustomerAdAccount<T>(
  principal: CustomerPrincipal,
  destinationId: string,
  invoke: (account: PlatformUserAccount) => Promise<T>,
): Promise<T> {
  const connections = customerConnections();
  const authorizations = await connections.list(principal);
  const authorization = authorizations.find((grant) =>
    grant.destinations.some((destination) => destination.id === destinationId),
  );
  if (!authorization) fail("NOT_FOUND", 404, "Destination not found.");
  if (authorization.connectionMode !== "LIVE")
    fail("LIVE_ADS_UNAVAILABLE", 503, "This connection cannot use the live advertising adapters.");
  const requiredScopes =
    authorization.provider === "GOOGLE"
      ? ["https://www.googleapis.com/auth/adwords"]
      : authorization.provider === "META"
        ? ["ads_management"]
        : undefined;
  if (!requiredScopes)
    fail(
      "UNSUPPORTED_PLATFORM",
      400,
      "This advertising platform is not enabled.",
    );
  const job = await connections.queueOperation(
    principal,
    destinationId,
    "ADS",
    requiredScopes,
  );
  return connections.runOperation(job.id, (credentials) =>
    invoke({
      id: destinationId,
      userId: credentials.userId,
      platform: credentials.provider,
      externalId: credentials.externalId,
      accessToken: credentials.accessToken,
      refreshToken: credentials.refreshToken,
      meta: {
        connectionMode: credentials.connectionMode,
        ...(credentials.selectedContext && typeof credentials.selectedContext === "object" && !Array.isArray(credentials.selectedContext)
          ? credentials.selectedContext : {}),
      },
    }),
  );
}
