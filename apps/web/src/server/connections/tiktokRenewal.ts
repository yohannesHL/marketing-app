import type { PrismaClient } from "../../generated/prisma/client";
import { CredentialVault } from "../security/credentialVault";
import { TikTokClient, TikTokError, TIKTOK_SCOPES, type TikTokConfig } from "../providers/tiktok";
import { SocialCredentialRenewalState, SocialRenewalExchangeError } from "./socialCredentialRenewalState";

export type TikTokRenewalRequest = {
  ownerId: string; authorizationId: string; generation: number; credentialVersion: number;
  verifyCurrent(): Promise<void>;
};
/** Both the offline worker and authenticated connection actions use the same durable rotation fence. */
export function renewTikTokPublishing(db: PrismaClient, vault: CredentialVault, config: TikTokConfig, request: TikTokRenewalRequest) {
  const client = new TikTokClient(config);
  return new SocialCredentialRenewalState(db, vault, { mode: client.mode, now: config.now }).renew({
    ownerId: request.ownerId, authorizationId: request.authorizationId, provider: "TIKTOK",
    generation: request.generation, credentialVersion: request.credentialVersion, requiredScopes: [...TIKTOK_SCOPES],
    verifyCaller: request.verifyCurrent,
    exchange: async (snapshot, beforeRequest) => {
      let guardFailed = false;
      try {
        return await new TikTokClient({ ...config, beforeRequest: async () => {
          try { await config.beforeRequest?.(); await beforeRequest(); } catch (error) { guardFailed = true; throw error; }
        } })
          .renewVerified({ providerUserId: snapshot.providerUserId, refreshToken: snapshot.refreshToken });
      } catch (error) {
        if (!guardFailed && error instanceof TikTokError && error.status === 429 && !error.outcomeUnknown)
          throw new SocialRenewalExchangeError("RATE_LIMIT", true, error.retryAfterMs);
        throw error;
      }
    },
  });
}
