import { prisma } from "../prisma/client";
import { customerAuth, customerConnections } from "../security/runtime";
import { CredentialVault } from "../security/credentialVault";
import { fail, securityResponse } from "../security/errors";
import { LINKEDIN_MEMBER_SCOPES, LINKEDIN_ORGANIZATION_SCOPES, LINKEDIN_VERSION, type LinkedInConfig } from "../providers/linkedin";
import { ProviderConnectionState } from "./providerConnectionState";
import { SocialConnectionState } from "./socialConnectionState";
import { LinkedInConnectionState } from "./linkedinConnectionState";
import { LinkedInConnectionService, createLinkedInConnectionApi, type LinkedInConnectionRenewal } from "./linkedinConnectionApi";
import { oauthBrowserFailure } from "./oauthBrowserResponse";
import { renewLinkedInPublishing } from "./linkedinRenewal";
import { SocialProviderFailure } from "../social/types";
const allowedScopes = new Set<string>([...LINKEDIN_MEMBER_SCOPES, ...LINKEDIN_ORGANIZATION_SCOPES, "r_member_social"]);
/** Request only permissions explicitly approved for the configured app's member/organization workflows. */
export function linkedInScopes(environment: NodeJS.ProcessEnv = process.env): string[] {
  let scopes: unknown;
  try { scopes = JSON.parse(environment.LINKEDIN_SCOPES ?? "null"); } catch { fail("INVALID_CONFIG", 503, "Configure approved LinkedIn scopes as a JSON array."); }
  if (!Array.isArray(scopes) || scopes.length > allowedScopes.size || new Set(scopes).size !== scopes.length || scopes.some(scope => typeof scope !== "string" || !allowedScopes.has(scope)) ||
    !["openid", "profile"].every(scope => scopes.includes(scope)) || !scopes.some(scope => ["w_member_social", "w_organization_social"].includes(scope)))
    fail("INVALID_CONFIG", 503, "Configure only approved LinkedIn identity and social-publishing permissions.");
  return [...scopes] as string[];
}
export function linkedinProviderConfig(beforeRequest?: () => Promise<void>): LinkedInConfig {
  const mode = process.env.CONNECTION_MODE;
  if (mode !== "mock" && mode !== "live") fail("PROVIDER_DISABLED", 503, "Configure an explicit LinkedIn provider mode.");
  if (mode === "mock" && !process.env.LINKEDIN_MOCKOON_URL) fail("INVALID_CONFIG", 503, "Configure the local LinkedIn Mockoon API.");
  return { clientId: mode === "mock" ? "li-client" : process.env.LINKEDIN_CLIENT_ID ?? "",
    clientSecret: mode === "mock" ? "fixture-li-secret" : process.env.LINKEDIN_CLIENT_SECRET ?? "",
    redirectUri: `${customerAuth().origin}/api/connections/linkedin/callback`, scopes: linkedInScopes(), version: LINKEDIN_VERSION,
    mdpRefreshEnabled: process.env.LINKEDIN_MDP_REFRESH_ENABLED === "true",
    ...(mode === "mock" ? { mockoonEnabled: true, mockoonBaseUrl: process.env.LINKEDIN_MOCKOON_URL } : {}), ...(beforeRequest ? { beforeRequest } : {}) };
}
export function linkedinConnectionService(renew: LinkedInConnectionRenewal = async (request) => {
  await request.verifyCurrent();
  const row = await prisma.providerAuthorization.findUnique({ where: { id: request.authorizationId } });
  if (!row || row.provider !== "LINKEDIN" || row.capability !== "SOCIAL" || row.providerUserId !== request.providerUserId ||
    row.connectionMode.toLowerCase() !== request.mode) fail("STALE_CREDENTIALS", 409, "The LinkedIn authorization changed.");
  try { await renewLinkedInPublishing(prisma, CredentialVault.fromEnvironment(), linkedinProviderConfig(), {
    ownerId: row.userId, authorizationId: row.id, generation: row.generation, credentialVersion: request.credentialVersion,
    verifyCurrent: request.verifyCurrent,
  }); } catch (error) {
    if (error instanceof SocialProviderFailure && error.definitive && ["RATE_LIMIT", "TRANSIENT"].includes(error.kind))
      fail("PROVIDER_RATE_LIMITED", 429, "Publishing access is being renewed. Wait briefly before checking again.");
    throw error;
  }
}) {
  const auth = customerAuth();
  return new LinkedInConnectionService(auth, customerConnections(), new ProviderConnectionState(prisma, auth, CredentialVault.fromEnvironment()),
    new SocialConnectionState(prisma, auth), new LinkedInConnectionState(prisma, auth), linkedinProviderConfig(),
    process.env.CONNECTION_MODE as "mock" | "live", () => new Date(), renew);
}
export async function handleLinkedInConnectionApi(request: Request) {
  let origin: string | undefined;
  try { const auth = customerAuth(); origin = auth.origin; await auth.requireSession(request); return await createLinkedInConnectionApi(auth, linkedinConnectionService())(request); }
  catch (error) {
    if (origin && request.method === "GET" && new URL(request.url).pathname === "/api/connections/linkedin/callback" && request.headers.get("accept")?.includes("text/html"))
      return oauthBrowserFailure(origin, "linkedin", error);
    return securityResponse(error);
  }
}
