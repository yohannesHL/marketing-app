import { prisma } from "../prisma/client";
import { customerAuth, customerConnections } from "../security/runtime";
import { CredentialVault } from "../security/credentialVault";
import { fail, securityResponse } from "../security/errors";
import { YouTubeClient, type YouTubeConfig } from "../providers/youtube";
import { ProviderConnectionState } from "./providerConnectionState";
import { SocialConnectionState } from "./socialConnectionState";
import { YouTubeConnectionService, createYouTubeConnectionApi } from "./youtubeConnectionApi";
import { oauthBrowserFailure } from "./oauthBrowserResponse";

export function youtubeProviderConfig(beforeRequest?: () => Promise<void>): YouTubeConfig {
  const mode = process.env.CONNECTION_MODE;
  if (mode !== "mock" && mode !== "live") fail("PROVIDER_DISABLED", 503, "Enable an explicit connection mode.");
  if (mode === "mock" && !process.env.YOUTUBE_MOCKOON_URL)
    fail("INVALID_CONFIG", 503, "Configure the local YouTube Mockoon API.");
  return { clientId: mode === "mock" ? "yt-client" : process.env.YOUTUBE_CLIENT_ID ?? "",
    clientSecret: mode === "mock" ? "fixture-yt-secret" : process.env.YOUTUBE_CLIENT_SECRET ?? "",
    redirectUri: `${customerAuth().origin}/api/connections/youtube/callback`,
    ...(mode === "mock" ? { mockoonEnabled: true, mockoonBaseUrl: process.env.YOUTUBE_MOCKOON_URL } : {}),
    ...(beforeRequest ? { beforeRequest } : {}) };
}
export function youtubeConnectionService() {
  const auth = customerAuth(), client = new YouTubeClient(youtubeProviderConfig());
  return new YouTubeConnectionService(auth, customerConnections(),
    new ProviderConnectionState(prisma, auth, CredentialVault.fromEnvironment()),
    new SocialConnectionState(prisma, auth), client, process.env.CONNECTION_MODE as "mock" | "live");
}
export async function handleYouTubeConnectionApi(request: Request) {
  let origin: string | undefined;
  try {
    const auth = customerAuth(); origin = auth.origin;
    await auth.requireSession(request);
    return await createYouTubeConnectionApi(auth, youtubeConnectionService())(request);
  } catch (error) {
    if (origin && new URL(request.url).pathname === "/api/connections/youtube/callback" && request.headers.get("accept")?.includes("text/html"))
      return oauthBrowserFailure(origin, "youtube", error);
    return securityResponse(error);
  }
}
