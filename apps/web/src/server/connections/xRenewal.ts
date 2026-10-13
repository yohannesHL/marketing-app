import type { PrismaClient } from "../../generated/prisma/client";
import { CredentialVault } from "../security/credentialVault";
import { fail } from "../security/errors";
import { XClient, XError, X_SCOPES, type XConfig } from "../providers/x";
import { SocialCredentialRenewalState, SocialRenewalExchangeError } from "./socialCredentialRenewalState";
export type XRenewalRequest = {
  ownerId: string; authorizationId: string; generation: number; credentialVersion: number;
  verifyCurrent(): Promise<void>;
  /** Reserve the one identity read against an immutable job or session-owned connection approval. */
  prefundUserRead(): Promise<void>;
};
/** Only the winning unstarted lease reserves funding; no rotating token is sent before that commits. */
export function renewXPublishing(db: PrismaClient, vault: CredentialVault, config: XConfig, request: XRenewalRequest) {
  if (typeof request.prefundUserRead !== "function") fail("API_COST_APPROVAL_REQUIRED", 503, "Approve the X renewal identity-read allowance first.");
  const client = new XClient(config);
  return new SocialCredentialRenewalState(db, vault, { mode: client.mode, now: config.now }).renew({
    ownerId: request.ownerId, authorizationId: request.authorizationId, provider: "X", generation: request.generation,
    credentialVersion: request.credentialVersion, requiredScopes: [...X_SCOPES], verifyCaller: request.verifyCurrent,
    exchange: async (snapshot, beforeRequest) => {
      await request.verifyCurrent();
      await request.prefundUserRead();
      let coupon = true, guardFailed = false;
      try {
        const grant = await new XClient({ ...config,
          beforeRequest: async () => {
            try { await config.beforeRequest?.(); await beforeRequest(); }
            catch (error) { guardFailed = true; throw error; }
          },
          beforeBillableRequest: async operation => {
            if (operation !== "USER_READ" || !coupon) fail("INVALID_RENEWAL_PROTOCOL", 502, "The X renewal exceeded its approved identity-read allowance.");
            coupon = false;
          },
        }).renewVerified({ providerUserId: snapshot.providerUserId, refreshToken: snapshot.refreshToken });
        if (coupon) fail("INVALID_RENEWAL_PROTOCOL", 502, "The X renewal did not verify its funded identity read.");
        return { ...grant, refreshExpiresAt: null };
      } catch (error) {
        if (!guardFailed && error instanceof XError && error.status === 429 && !error.outcomeUnknown)
          throw new SocialRenewalExchangeError("RATE_LIMIT", true, error.retryAfterMs);
        throw error;
      }
    },
  });
}
