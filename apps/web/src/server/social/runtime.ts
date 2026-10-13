import { prisma } from "../prisma/client";
import { customerAuth } from "../security/runtime";
import { CredentialVault } from "../security/credentialVault";
import { SocialDeliveryWorker } from "./deliveryWorker";
import { SocialMediaStore } from "./mediaStore";
import { SocialPostService } from "./postService";
import { SocialProviderRegistry } from "./types";
import { socialConfiguration } from "./configuration";
import { youtubeProviderConfig } from "../connections/youtubeRuntime";
import { YouTubeClient } from "../providers/youtube";
import { youtubeSocialRegistration } from "./providers/youtube";
import { fail } from "../security/errors";
import { metaPublishingProviderConfig, resolveMetaPublishingPageCredential } from "../connections/metaPublishingRuntime";
import { MetaPublishingClient } from "../providers/metaPublishing";
import { metaPublishingRegistration } from "./providers/metaPublishing";
import { tiktokProviderConfig } from "../connections/tiktokRuntime";
import { renewTikTokPublishing } from "../connections/tiktokRenewal";
import { TikTokClient } from "../providers/tiktok";
import { tiktokSocialRegistration } from "./providers/tiktok";

/** Providers are added only by their separately validated implementation slices. */
export function socialProviders() {
  const registry = new SocialProviderRegistry();
  try {
    const config = youtubeProviderConfig();
    new YouTubeClient(config);
    registry.register({ ...youtubeSocialRegistration(config, { mediaOrigin: process.env.SOCIAL_MEDIA_PUBLIC_ORIGIN ?? customerAuth().origin }), renewableCredentials: true });
  } catch { /* Unconfigured providers stay disabled; another provider's drafts remain available. */ }
  try {
    const config = metaPublishingProviderConfig();
    new MetaPublishingClient(config);
    const providerConfig = { ...config, mediaOrigin: process.env.SOCIAL_MEDIA_PUBLIC_ORIGIN ?? customerAuth().origin,
      resolvePageCredential: resolveMetaPublishingPageCredential };
    registry.register(metaPublishingRegistration("FACEBOOK_PAGE", providerConfig));
    registry.register(metaPublishingRegistration("INSTAGRAM_PROFILE", providerConfig));
  } catch { /* Each separately configured publishing integration fails closed. */ }
  try {
    const config = tiktokProviderConfig(); new TikTokClient(config);
    registry.register({ ...tiktokSocialRegistration(config, { verifiedMediaPrefix: process.env.TIKTOK_VERIFIED_MEDIA_PREFIX ?? "",
      audited: process.env.TIKTOK_APP_AUDITED === "true" }), renewableCredentials: true });
  } catch { /* Missing verified media ownership leaves this provider unavailable. */ }
  return registry;
}

export function socialMediaStore() {
  const { mode } = socialConfiguration();
  return new SocialMediaStore(prisma, { mode,
    directory: process.env.SOCIAL_MEDIA_DIRECTORY ?? "", origin: process.env.SOCIAL_MEDIA_PUBLIC_ORIGIN ?? "",
    signingKey: process.env.SOCIAL_MEDIA_SIGNING_KEY ?? "",
    ...(process.env.SOCIAL_MEDIA_MAX_BYTES ? { maxBytes: Number(process.env.SOCIAL_MEDIA_MAX_BYTES) } : {}),
    ...(process.env.SOCIAL_FFPROBE_PATH ? { probeExecutable: process.env.SOCIAL_FFPROBE_PATH } : {}),
  });
}

export function socialPostService() {
  return new SocialPostService(prisma, customerAuth(), socialConfiguration(), socialProviders());
}

export function socialDeliveryWorker() {
  return new SocialDeliveryWorker(prisma, CredentialVault.fromEnvironment(), socialProviders(), socialConfiguration(),
    (request) => socialMediaStore().resolve(request), () => new Date(), async (request) => {
      if (request.provider === "TIKTOK") return renewTikTokPublishing(prisma, CredentialVault.fromEnvironment(), tiktokProviderConfig(), {
        ownerId: request.ownerId, authorizationId: request.authorizationId, generation: request.authorizationGeneration,
        credentialVersion: request.credentialVersion, verifyCurrent: request.verifyCurrent,
      });
      if (request.provider !== "GOOGLE") fail("RECONNECT_REQUIRED", 409, "This provider needs renewed customer authorization.");
      const client = new YouTubeClient(youtubeProviderConfig(request.verifyCurrent));
      return client.renewVerified({ providerUserId: request.providerUserId, refreshToken: request.refreshToken, scopes: request.scopes });
    });
}
