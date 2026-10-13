import { CustomerAuth,type CustomerPrincipal } from "../auth/customerAuth";
import { CustomerConnections,type OAuthRequest } from "./customerConnections";
import { ProviderConnectionState } from "./providerConnectionState";
import { SocialConnectionState } from "./socialConnectionState";
import { MetaPageCredentialStore } from "./metaPageCredentialStore";
import { MetaPublishingClient,MetaPublishingError,META_PUBLISHING_SCOPES,type MetaSocialDestination } from "../providers/metaPublishing";
import { fail,privateJson,readBody,securityResponse,SecurityError } from "../security/errors";
import { oauthBrowserFailure } from "./oauthBrowserResponse";

export class MetaPublishingConnectionService {
  readonly oauth:OAuthRequest;
  constructor(private readonly auth:CustomerAuth,private readonly connections:CustomerConnections,private readonly state:ProviderConnectionState,
    private readonly social:SocialConnectionState,private readonly pages:MetaPageCredentialStore,private readonly client:MetaPublishingClient,
    readonly mode:"mock"|"live",private readonly now=()=>new Date()) {
    this.oauth={provider:"META",capability:"SOCIAL",pkce:false,scopes:[...META_PUBLISHING_SCOPES],redirectUri:`${auth.origin}/api/connections/meta-publishing/callback`};
    if(client.mode!==mode||pages.mode!==mode||client.redirectUri!==this.oauth.redirectUri)fail("INVALID_CONFIG",503,"Configure a matching Meta publishing mode and callback.");
  }
  async start(principal:CustomerPrincipal,authorizationId?:string) {
    const attempt=await this.connections.beginOAuth(principal,{...this.oauth,reconnectAuthorizationId:authorizationId});
    return {authorizationUrl:this.client.authorizationUrl(attempt.state),mode:this.mode};
  }
  private destinations(rows:MetaSocialDestination[]) {
    return rows.map(row=>({kind:row.kind,externalId:row.externalId,name:row.name,available:row.canPublish,
      canRead:true,canWrite:row.canPublish ? "ALLOWED" as const:"DENIED" as const,pageId:row.pageId,tasks:row.tasks}));
  }
  async complete(principal:CustomerPrincipal,state:string,code?:string,denied=false,failed=false) {
    const attempt=await this.connections.claimOAuthExchange(principal,state,this.oauth);
    try {
      if (failed) fail("PROVIDER_AUTHORIZATION_FAILED",502,"Meta could not authorize publishing. Start again.");
      if (denied) fail("CONSENT_DENIED",400,"Meta publishing permission was declined.");
      if (!code || code.length>4096) fail("INVALID_OAUTH_CODE",400,"Restart the Meta publishing connection.");
      const previous=attempt.reconnectAuthorizationId ? await this.state.grant(principal,attempt.reconnectAuthorizationId,"META","SOCIAL",true):undefined;
      if (previous && previous.connectionMode!==this.mode.toUpperCase()) fail("CONNECTION_MODE_MISMATCH",409,"Create a new connection when changing provider modes.");
      const grant=await this.client.exchangeCode(code,previous?.providerUserId);
      const discovered=await this.client.discoverDestinations(grant.accessToken,grant.providerUserId);
      const connection=await this.connections.completeAuthorization(principal,state,this.oauth,{...grant,connectionMode:this.mode.toUpperCase() as "MOCK"|"LIVE"},attempt.exchangeClaimToken);
      await this.pages.persist(principal,connection.id,connection.credentialVersion,discovered.pageCredentials,grant.expiresAt);
      await this.social.synchronize(principal,connection.id,"META",connection.credentialVersion,this.destinations(discovered.destinations));
      return {connection:await this.connections.get(principal,connection.id),mode:this.mode};
    } catch(error) {await this.state.cancelOAuth(principal,state,this.oauth,attempt.exchangeClaimToken);throw error;}
  }
  async refresh(principal:CustomerPrincipal,id:string,destinationId?:string,select=false) {
    const grant=await this.state.grant(principal,id,"META","SOCIAL");
    if (grant.connectionMode!==this.mode.toUpperCase()) fail("CONNECTION_MODE_MISMATCH",409,"This connection belongs to another provider mode.");
    if (!grant.accessToken || (grant.expiresAt && grant.expiresAt<=this.now())) {
      await this.state.requireReconnect(principal,id,grant.credentialVersion);fail("RECONNECT_REQUIRED",409,"Reconnect the Meta publishing account.");
    }
    const connection=await this.connections.get(principal,id);
    const destination=destinationId ? connection.destinations.find(d=>d.id===destinationId&&["FACEBOOK_PAGE","INSTAGRAM_PROFILE"].includes(d.kind)):undefined;
    if (destinationId && !destination) fail("NOT_FOUND",404,"Choose a publishing destination from this connection.");
    try {
      const discovered=await this.client.discoverDestinations(grant.accessToken,grant.providerUserId);
      await this.pages.persist(principal,id,grant.credentialVersion,discovered.pageCredentials,grant.expiresAt);
      await this.social.synchronize(principal,id,"META",grant.credentialVersion,this.destinations(discovered.destinations));
      if (destination) {
        const current=discovered.destinations.find(d=>d.kind===destination.kind&&d.externalId===destination.externalId);
        if (!current?.canPublish) fail("DESTINATION_UNAVAILABLE",409,"This destination cannot publish content.");
        const credential=discovered.pageCredentials.find(c=>c.pageId===current.pageId);
        if (!credential) fail("CREDENTIAL_UNAVAILABLE",503,"Verified Page credentials are unavailable.");
        try { await this.client.verifyTarget(grant.accessToken,credential,current.kind,current.externalId,grant.providerUserId); }
        catch(error) {
          if (error instanceof MetaPublishingError && ["TARGET_UNAVAILABLE","TARGET_MISMATCH"].includes(error.code))
            await this.social.synchronize(principal,id,"META",grant.credentialVersion,this.destinations(discovered.destinations).map(row=>
              row.kind===current.kind&&row.externalId===current.externalId ? {...row,available:false,canWrite:"DENIED" as const}:row));
          throw error;
        }
        // Synchronize version fence again after the provider check before selection.
        await this.social.synchronize(principal,id,"META",grant.credentialVersion,this.destinations(discovered.destinations));
        if (select) await this.social.select(principal,id,"META",grant.credentialVersion,destination.id,this.mode);
      }
      return {connection:await this.connections.get(principal,id),mode:this.mode};
    } catch(error) {
      if (error instanceof MetaPublishingError && ["RECONNECT_REQUIRED","MISSING_PERMISSION","SUBJECT_MISMATCH"].includes(error.code))
        await this.state.requireReconnect(principal,id,grant.credentialVersion);
      throw error;
    }
  }
}
function responseError(error:unknown) {
  return securityResponse(error instanceof MetaPublishingError ? new SecurityError(error.code,error.status,"The Meta publishing connection could not be checked."):error);
}
export function createMetaPublishingConnectionApi(auth:CustomerAuth,service:MetaPublishingConnectionService) {
  return async(request:Request)=>{
    const url=new URL(request.url),callback=url.pathname==="/api/connections/meta-publishing/callback";
    const html=callback&&request.method==="GET"&&request.headers.get("accept")?.includes("text/html");
    try {
      const principal=await auth.requireSession(request);
      if (callback&&request.method==="GET") {
        const result=await service.complete(principal,url.searchParams.get("state")??"",url.searchParams.get("code")??undefined,
          url.searchParams.get("error")==="access_denied",url.searchParams.has("error")&&url.searchParams.get("error")!=="access_denied");
        if (html)return new Response(null,{status:303,headers:{Location:`${auth.origin}/connections?provider=meta-publishing&result=connected`,"Cache-Control":"no-store","Referrer-Policy":"no-referrer"}});
        return privateJson(result);
      }
      auth.assertOrigin(request);if(request.method!=="POST")fail("METHOD_NOT_ALLOWED",405,"Use POST for connection actions.");
      const body=await readBody(request);
      if(url.pathname==="/api/connections/meta-publishing/start") {
        if(Object.keys(body).some(k=>k!=="authorizationId")||(body.authorizationId!==undefined&&typeof body.authorizationId!=="string"))fail("INVALID_BODY",400,"Supply only an optional connection to reconnect.");
        return privateJson(await service.start(principal,body.authorizationId as string|undefined));
      }
      const match=url.pathname.match(/^\/api\/connections\/meta-publishing\/([A-Za-z0-9_-]{1,128})\/(refresh|check|select)$/);
      if(!match)fail("NOT_FOUND",404,"Meta publishing action not found.");
      if(match[2]==="refresh") {if(Object.keys(body).length)fail("INVALID_BODY",400,"Discovery does not accept credentials or provider IDs.");return privateJson(await service.refresh(principal,match[1]));}
      if(Object.keys(body).some(k=>k!=="destinationId")||typeof body.destinationId!=="string")fail("INVALID_BODY",400,"Supply an owned destination ID.");
      return privateJson(await service.refresh(principal,match[1],body.destinationId,match[2]==="select"));
    } catch(error) {return html ? oauthBrowserFailure(auth.origin,"meta-publishing",error):responseError(error);}
  };
}
