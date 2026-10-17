import { prisma } from "../prisma/client";
import { CredentialVault } from "../security/credentialVault";
import { fail, securityResponse } from "../security/errors";
import { customerAuth } from "../security/runtime";
import { createEmailApi } from "./emailApi";
import { EmailConnectionService } from "./emailConnectionService";
import { EmailDeliveryService } from "./emailDeliveryService";
import { MarketingCampaignService } from "./marketingCampaignService";
import type { EmailProviderFactory } from "./emailProvider";
import { createResendProvider } from "./resendProvider";

export function emailProviderFactory(env: NodeJS.ProcessEnv = process.env): EmailProviderFactory {
  const liveEnabled = env.EMAIL_LIVE_DELIVERY_ENABLED === "true";
  const fixtureOrigin = env.CONNECTION_MODE === "mock" ? env.EMAIL_TEST_PROVIDER_ORIGIN : undefined;
  return environment => {
    if (environment === "LIVE") return createResendProvider({ environment, liveEnabled });
    if (!fixtureOrigin) fail("EMAIL_TEST_PROVIDER_UNAVAILABLE", 503, "Configure an explicit loopback email fixture in mock mode for TEST.");
    return createResendProvider({ environment, fixture: { origin: fixtureOrigin, fetch } });
  };
}
export function emailServices() {
  const auth = customerAuth(), vault = CredentialVault.fromEnvironment(), providerFor = emailProviderFactory();
  const origin = process.env.APP_ORIGIN!;
  const liveEnabled = process.env.EMAIL_LIVE_DELIVERY_ENABLED === "true";
  return { auth, connections: new EmailConnectionService(prisma, auth, vault, providerFor, origin),
    campaigns: new MarketingCampaignService(prisma, auth, () => new Date(), liveEnabled),
    delivery: new EmailDeliveryService(prisma, auth, vault, providerFor, { liveEnabled, unsubscribeBaseUrl: `${origin}/unsubscribe` }) };
}
export async function handleEmailApi(request: Request) {
  try { const { auth, connections, campaigns, delivery } = emailServices(); return await createEmailApi(auth, connections, campaigns, delivery)(request); }
  catch (error) { return securityResponse(error); }
}
