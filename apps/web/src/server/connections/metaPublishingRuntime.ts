import { prisma } from "../prisma/client";
import { customerAuth,customerConnections } from "../security/runtime";
import { CredentialVault } from "../security/credentialVault";
import { fail,securityResponse } from "../security/errors";
import { MetaPublishingClient,type MetaPublishingConfig } from "../providers/metaPublishing";
import type { SocialProviderCall } from "../social/types";
import { ProviderConnectionState } from "./providerConnectionState";
import { SocialConnectionState } from "./socialConnectionState";
import { MetaPageCredentialStore } from "./metaPageCredentialStore";
import { MetaPublishingConnectionService,createMetaPublishingConnectionApi } from "./metaPublishingConnectionApi";
import { oauthBrowserFailure } from "./oauthBrowserResponse";

export function metaPublishingProviderConfig(beforeRequest?:()=>Promise<void>):MetaPublishingConfig {
  const mode=process.env.CONNECTION_MODE;
  if(mode!=="mock"&&mode!=="live")fail("PROVIDER_DISABLED",503,"Enable an explicit connection mode.");
  if(mode==="mock"&&!process.env.META_PUBLISHING_MOCKOON_URL)fail("INVALID_CONFIG",503,"Configure the local Meta publishing Mockoon API.");
  if(mode==="live"&&(!process.env.META_APP_ID||!process.env.META_APP_SECRET||!process.env.META_PUBLISHING_CONFIG_ID))
    fail("INVALID_CONFIG",503,"Configure the Meta app and its separate publishing login configuration.");
  return {mode,appId:mode==="mock"?"123":process.env.META_APP_ID!,appSecret:mode==="mock"?"fixture-app-secret":process.env.META_APP_SECRET!,
    configId:mode==="mock"?"789":process.env.META_PUBLISHING_CONFIG_ID!,redirectUri:`${customerAuth().origin}/api/connections/meta-publishing/callback`,
    graphVersion:process.env.META_GRAPH_VERSION??"v26.0",...(mode==="mock"?{testBaseUrl:process.env.META_PUBLISHING_MOCKOON_URL}:{}),
    ...(beforeRequest?{beforeRequest}:{})};
}
export function metaPageCredentialStore() {
  const mode=process.env.CONNECTION_MODE;
  if(mode!=="mock"&&mode!=="live")fail("PROVIDER_DISABLED",503,"Enable an explicit connection mode.");
  return new MetaPageCredentialStore(prisma,customerAuth(),CredentialVault.fromEnvironment(),mode);
}
export async function resolveMetaPublishingPageCredential(call:SocialProviderCall) {return metaPageCredentialStore().resolve(call);}
export function metaPublishingConnectionService() {
  const auth=customerAuth(),config=metaPublishingProviderConfig(),vault=CredentialVault.fromEnvironment();
  return new MetaPublishingConnectionService(auth,customerConnections(),new ProviderConnectionState(prisma,auth,vault),
    new SocialConnectionState(prisma,auth),new MetaPageCredentialStore(prisma,auth,vault,config.mode!),new MetaPublishingClient(config),config.mode!);
}
export async function handleMetaPublishingConnectionApi(request:Request) {
  let origin:string|undefined;
  try {const auth=customerAuth();origin=auth.origin;await auth.requireSession(request);return await createMetaPublishingConnectionApi(auth,metaPublishingConnectionService())(request);}
  catch(error){if(origin&&new URL(request.url).pathname==="/api/connections/meta-publishing/callback"&&request.headers.get("accept")?.includes("text/html"))return oauthBrowserFailure(origin,"meta-publishing",error);return securityResponse(error);}
}
