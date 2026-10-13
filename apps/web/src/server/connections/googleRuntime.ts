import { GoogleAdsClient } from "../providers/googleAds";
import { prisma } from "../prisma/client";
import { customerAuth, customerConnections } from "../security/runtime";
import { CredentialVault } from "../security/credentialVault";
import { fail } from "../security/errors";
import { GoogleConnectionService, createGoogleConnectionApi, providerResponse } from "./googleConnectionApi";
import { ProviderConnectionState } from "./providerConnectionState";

export function googleConnectionService() {
  const auth = customerAuth();
  const mode = process.env.CONNECTION_MODE;
  if (mode !== "mock" && mode !== "live")
    fail("PROVIDER_DISABLED", 503, "Enable an explicit connection mode before connecting Google.");
  const mock = mode === "mock";
  if (mock && !process.env.GOOGLE_ADS_MOCKOON_URL)
    fail("INVALID_CONFIG", 503, "Configure the local Google Mockoon API before connecting.");
  const client = new GoogleAdsClient({
    clientId: mock ? "mock-google-client" : process.env.GOOGLE_CLIENT_ID ?? "",
    clientSecret: mock ? "mock-google-secret" : process.env.GOOGLE_CLIENT_SECRET ?? "",
    redirectUri: `${auth.origin}/api/connections/google/callback`,
    apiVersion: "v25",
    ...(mock ? { mockoonEnabled: true, mockoonBaseUrl: process.env.GOOGLE_ADS_MOCKOON_URL } : {}),
  });
  return new GoogleConnectionService(auth, customerConnections(),
    new ProviderConnectionState(prisma, auth, CredentialVault.fromEnvironment()), client, mode);
}

export async function handleGoogleConnectionApi(request: Request) {
  try {
    const auth = customerAuth();
    await auth.requireSession(request);
    return await createGoogleConnectionApi(auth, googleConnectionService())(request);
  }
  catch (error) { return providerResponse(error); }
}
