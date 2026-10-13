import { prisma } from "../prisma/client";
import { customerAuth } from "../security/runtime";
import { CredentialVault } from "../security/credentialVault";
import { SocialDeliveryWorker } from "./deliveryWorker";
import { SocialMediaStore } from "./mediaStore";
import { SocialPostService } from "./postService";
import { SocialProviderRegistry } from "./types";
import { socialConfiguration } from "./configuration";

/** Providers are added only by their separately validated implementation slices. */
export function socialProviders() { return new SocialProviderRegistry(); }

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
    (request) => socialMediaStore().resolve(request));
}
