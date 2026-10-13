import { prisma } from "../prisma/client";
import { customerAuth, customerConnections } from "../security/runtime";
import { CredentialVault } from "../security/credentialVault";
import { fail, securityResponse } from "../security/errors";
import { TikTokClient, type TikTokConfig } from "../providers/tiktok";
import { ProviderConnectionState } from "./providerConnectionState";
import { SocialConnectionState } from "./socialConnectionState";
import { TikTokCreatorState } from "./tiktokCreatorState";
import { TikTokConnectionService, createTikTokConnectionApi, type TikTokConnectionRenewal } from "./tiktokConnectionApi";
import { oauthBrowserFailure } from "./oauthBrowserResponse";
import { renewTikTokPublishing } from "./tiktokRenewal";
import { SocialProviderFailure } from "../social/types";
export function tiktokProviderConfig(beforeRequest?: () => Promise<void>): TikTokConfig {
  const mode = process.env.CONNECTION_MODE;
  if (mode !== "mock" && mode !== "live") fail("PROVIDER_DISABLED", 503, "Enable an explicit connection mode.");
  if (mode === "mock" && !process.env.TIKTOK_MOCKOON_URL) fail("INVALID_CONFIG", 503, "Configure the local TikTok Mockoon API.");
  return { clientKey: mode === "mock" ? "tt-client" : process.env.TIKTOK_CLIENT_KEY ?? "",
    clientSecret: mode === "mock" ? "fixture-tt-secret" : process.env.TIKTOK_CLIENT_SECRET ?? "",
    redirectUri: `${customerAuth().origin}/api/connections/tiktok/callback`,
    ...(mode === "mock" ? { mockoonEnabled: true, mockoonBaseUrl: process.env.TIKTOK_MOCKOON_URL } : {}), ...(beforeRequest ? { beforeRequest } : {}) };
}
export function tiktokConnectionService(renew: TikTokConnectionRenewal = async (request) => {
  await request.verifyCurrent();
  const row = await prisma.providerAuthorization.findUnique({ where: { id: request.authorizationId } });
  if (!row || row.provider !== "TIKTOK" || row.capability !== "SOCIAL" || row.providerUserId !== request.providerUserId ||
    row.connectionMode.toLowerCase() !== request.mode) fail("STALE_CREDENTIALS", 409, "The TikTok authorization changed.");
  try { await renewTikTokPublishing(prisma, CredentialVault.fromEnvironment(), tiktokProviderConfig(), {
    ownerId: row.userId, authorizationId: row.id, generation: row.generation, credentialVersion: request.credentialVersion,
    verifyCurrent: request.verifyCurrent,
  }); } catch (error) {
    if (error instanceof SocialProviderFailure && error.definitive && ["RATE_LIMIT", "TRANSIENT"].includes(error.kind))
      fail("PROVIDER_RATE_LIMITED", 429, "Publishing access is being renewed. Wait briefly before checking again.");
    throw error;
  }
}) {
  const auth = customerAuth(), config = tiktokProviderConfig(); new TikTokClient(config);
  return new TikTokConnectionService(auth, customerConnections(), new ProviderConnectionState(prisma, auth, CredentialVault.fromEnvironment()),
    new SocialConnectionState(prisma, auth), new TikTokCreatorState(prisma, auth), config, process.env.CONNECTION_MODE as "mock" | "live", () => new Date(), renew);
}
export async function handleTikTokConnectionApi(request: Request) {
  let origin: string | undefined;
  try { const auth = customerAuth(); origin = auth.origin; await auth.requireSession(request); return await createTikTokConnectionApi(auth, tiktokConnectionService())(request); }
  catch (error) {
    if (origin && request.method === "GET" && new URL(request.url).pathname === "/api/connections/tiktok/callback" && request.headers.get("accept")?.includes("text/html"))
      return oauthBrowserFailure(origin, "tiktok", error);
    return securityResponse(error);
  }
}
