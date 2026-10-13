import { fail } from "../security/errors";
import type { SocialWorkerConfig } from "./types";

const destinations = new Set(["GOOGLE:YOUTUBE_CHANNEL", "META:FACEBOOK_PAGE", "META:INSTAGRAM_PROFILE",
  "TIKTOK:TIKTOK_PROFILE", "LINKEDIN:LINKEDIN_MEMBER", "LINKEDIN:LINKEDIN_ORGANIZATION", "X:X_PROFILE"]);

export function socialConfiguration(environment: NodeJS.ProcessEnv = process.env): SocialWorkerConfig {
  const mode = environment.CONNECTION_MODE;
  if (mode !== "mock" && mode !== "live") fail("PROVIDER_DISABLED", 503, "Configure an explicit social connection mode.");
  if (environment.SOCIAL_PUBLISHING_ENABLED && !["true", "false"].includes(environment.SOCIAL_PUBLISHING_ENABLED))
    fail("PROVIDER_DISABLED", 503, "Configure an explicit social publishing switch.");
  let approved: unknown;
  try { approved = JSON.parse(environment.SOCIAL_APPROVED_PROVIDERS ?? "[]"); }
  catch { fail("PROVIDER_DISABLED", 503, "Configure an explicit social destination allowlist."); }
  if (!Array.isArray(approved) || approved.length > destinations.size ||
    approved.some((item) => typeof item !== "string" || !destinations.has(item)) || new Set(approved).size !== approved.length)
    fail("PROVIDER_DISABLED", 503, "Configure supported social destination types.");
  return { mode, writesEnabled: environment.SOCIAL_PUBLISHING_ENABLED === "true", approvedProviders: approved };
}
