import type { PrismaClient } from "../../generated/prisma/client";
import { CredentialVault } from "../security/credentialVault";
import { fail } from "../security/errors";
import { LinkedInClient, LinkedInError, type LinkedInConfig } from "../providers/linkedin";
import { SocialCredentialRenewalState, SocialRenewalExchangeError, type VerifiedRotatedSocialGrant } from "./socialCredentialRenewalState";

export type LinkedInRenewalRequest = {
  ownerId: string;
  authorizationId: string;
  generation: number;
  credentialVersion: number;
  verifyCurrent(): Promise<void>;
};

/** Only explicitly approved MDP credentials may renew; ordinary member consent never gains refresh access. */
export async function renewLinkedInPublishing(
  db: PrismaClient,
  vault: CredentialVault,
  config: LinkedInConfig,
  request: LinkedInRenewalRequest,
): Promise<VerifiedRotatedSocialGrant> {
  if (config.mockoonEnabled === true && !config.mockoonBaseUrl)
    fail("INVALID_CONFIG", 503, "Configure the explicit local LinkedIn fixture endpoint.");
  new LinkedInClient(config);
  if (config.mdpRefreshEnabled !== true)
    fail("RECONNECT_REQUIRED", 409, "Approved LinkedIn programmatic refresh access is required to renew this connection.");
  const mode = config.mockoonEnabled === true ? "mock" : "live";
  return new SocialCredentialRenewalState(db, vault, { mode, now: config.now }).renew({
    ownerId: request.ownerId,
    authorizationId: request.authorizationId,
    provider: "LINKEDIN",
    generation: request.generation,
    credentialVersion: request.credentialVersion,
    requiredScopes: config.scopes,
    verifyCaller: request.verifyCurrent,
    exchange: async (snapshot, beforeRequest) => {
      if (!snapshot.refreshExpiresAt || snapshot.refreshExpiresAt <= (config.now?.() ?? new Date()))
        fail("RECONNECT_REQUIRED", 409, "Reconnect LinkedIn with an actual, unexpired programmatic refresh grant.");
      let guardFailed = false;
      try {
        const renewed = await new LinkedInClient({
          ...config,
          beforeRequest: async () => {
            try { await config.beforeRequest?.(); await beforeRequest(); }
            catch (error) { guardFailed = true; throw error; }
          },
        }).renewVerified({
          providerUserId: snapshot.providerUserId,
          refreshToken: snapshot.refreshToken,
          refreshExpiresAt: snapshot.refreshExpiresAt,
          scopes: [...snapshot.scopes],
        });
        if (!renewed.refreshToken || !renewed.refreshExpiresAt)
          fail("RECONNECT_REQUIRED", 409, "LinkedIn did not return a verified programmatic refresh grant.");
        return { ...renewed, refreshToken: renewed.refreshToken, refreshExpiresAt: renewed.refreshExpiresAt };
      } catch (error) {
        // The durable coordinator only releases a started lease when this was the first HTTP.
        // Rate limits during introspection/identity after rotation still require reconnect.
        if (!guardFailed && error instanceof LinkedInError && error.status === 429 && !error.outcomeUnknown)
          throw new SocialRenewalExchangeError("RATE_LIMIT", true);
        throw error;
      }
    },
  });
}
