import { MetaAdsClient } from "../providers/metaAds";
import { prisma } from "../prisma/client";
import { customerAuth, customerConnections } from "../security/runtime";
import { CredentialVault } from "../security/credentialVault";
import { fail } from "../security/errors";
import { MetaConnectionService, createMetaConnectionApi, dispatchMetaLifecycle, metaProviderResponse,
} from "./metaConnectionApi";
import { ProviderConnectionState } from "./providerConnectionState";
import { metaLifecycleStore } from "./metaLifecycleStore";

function configuration(): { mode: "mock" | "live"; appId: string; appSecret: string;
  configId: string; testBaseUrl?: string } {
  const mode = process.env.CONNECTION_MODE;
  if (mode !== "mock" && mode !== "live")
    fail("PROVIDER_DISABLED", 503, "Enable an explicit connection mode before connecting Meta.");
  const mock = mode === "mock";
  if (mock && !process.env.META_ADS_MOCKOON_URL)
    fail("INVALID_CONFIG", 503, "Configure the local Meta Mockoon API before connecting.");
  if (!mock && (!process.env.META_APP_ID || !process.env.META_APP_SECRET || !process.env.META_LOGIN_CONFIG_ID))
    fail("INVALID_CONFIG", 503, "Configure Meta app credentials and its Ads login configuration before connecting.");
  return { mode, appId: mock ? "123" : process.env.META_APP_ID ?? "",
    appSecret: mock ? "fixture-app-secret" : process.env.META_APP_SECRET ?? "",
    configId: mock ? "456" : process.env.META_LOGIN_CONFIG_ID ?? "",
    ...(mock ? { testBaseUrl: process.env.META_ADS_MOCKOON_URL } : {}) };
}

export function metaConnectionService() {
  const auth = customerAuth();
  const config = configuration();
  const client = new MetaAdsClient({ ...config,
    redirectUri: `${auth.origin}/api/connections/meta/callback`,
    graphVersion: process.env.META_GRAPH_VERSION ?? "v26.0",
    marketingVersion: process.env.META_MARKETING_VERSION ?? "v26.0" });
  return new MetaConnectionService(auth, customerConnections(),
    new ProviderConnectionState(prisma, auth, CredentialVault.fromEnvironment()), client, config.mode);
}

/** Next route context is never interpreted as a lifecycle receiver. */
export async function handleMetaConnectionApi(request: Request) {
  try {
    const auth = customerAuth();
    const url = new URL(request.url);
    const publicCallback = ["/api/connections/meta/deauthorize", "/api/connections/meta/data-deletion"].includes(url.pathname) ||
      url.pathname.startsWith("/api/connections/meta/deletion-status/");
    if (publicCallback) {
      const secret = process.env.CONNECTION_MODE === "mock"
        ? "fixture-app-secret" : process.env.META_APP_SECRET;
      if (!secret && !url.pathname.startsWith("/api/connections/meta/deletion-status/"))
        fail("INVALID_CONFIG", 503, "Configure the Meta callback signing secret.");
      return (await dispatchMetaLifecycle(request, { appSecret: secret ?? "",
        lifecycle: metaLifecycleStore() }))!;
    }
    await auth.requireSession(request);
    return await createMetaConnectionApi(auth, metaConnectionService(),
      { appSecret: configuration().appSecret })(request);
  } catch (error) { return metaProviderResponse(error); }
}
