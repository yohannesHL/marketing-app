import type { MetaPageCredential, PrismaClient } from "../../generated/prisma/client";
import { CustomerAuth, type CustomerPrincipal } from "../auth/customerAuth";
import { CredentialVault } from "../security/credentialVault";
import { fail } from "../security/errors";
import { META_PUBLISHING_SCOPES, type MetaPageCredential as PrivatePageCredential } from "../providers/metaPublishing";
import type { SocialProviderCall } from "../social/types";

export function metaPageCredentialContext(row:Pick<MetaPageCredential,"ownerId"|"authorizationId"|"connectionMode"|"pageId"|"authorizationGeneration">) {
  return `meta-page-v1:${JSON.stringify([row.ownerId,row.authorizationId,row.connectionMode,row.pageId,row.authorizationGeneration])}`;
}
/** Page tokens are independent from public destination metadata and bound to one consent generation. */
export class MetaPageCredentialStore {
  constructor(private readonly db:PrismaClient,private readonly auth:CustomerAuth,private readonly vault:CredentialVault,
    readonly mode:"mock"|"live",private readonly now=()=>new Date()) {}
  async persist(principal:CustomerPrincipal,id:string,version:number,credentials:readonly PrivatePageCredential[],expiresAt?:Date|null) {
    await this.auth.assertSession(principal);
    if (credentials.length > 1000 || new Set(credentials.map(c=>c.pageId)).size !== credentials.length ||
      credentials.some(c=>!/^\d{1,64}$/.test(c.pageId)||!c.accessToken||c.accessToken.length>32768) ||
      (expiresAt && (!Number.isFinite(expiresAt.getTime()) || expiresAt<=this.now())))
      fail("INVALID_DISCOVERY",502,"Meta returned unusable Page credentials.");
    await this.db.$transaction(async tx=>{
      const grant=await tx.providerAuthorization.findFirst({where:{id,userId:principal.userId,provider:"META",capability:"SOCIAL",
        status:"CONNECTED",connectionMode:this.mode.toUpperCase(),credentialVersion:version}});
      if (!grant) fail("STALE_CREDENTIALS",409,"The publishing connection changed during discovery.");
      if (!grant.accessCiphertext || (grant.expiresAt && grant.expiresAt<=this.now())) fail("RECONNECT_REQUIRED",409,"Reconnect the Meta publishing account.");
      if (!Array.isArray(grant.scopes) || META_PUBLISHING_SCOPES.some(scope=>!(grant.scopes as string[]).includes(scope)))
        fail("MISSING_PERMISSION",403,"Reconnect and grant Meta publishing permissions.");
      const fence=await tx.providerAuthorization.updateMany({where:{id,userId:principal.userId,provider:"META",capability:"SOCIAL",
        status:"CONNECTED",connectionMode:grant.connectionMode,credentialVersion:version,generation:grant.generation},data:{updatedAt:this.now()}});
      if (fence.count!==1) fail("STALE_CREDENTIALS",409,"The publishing connection changed during discovery.");
      for (const credential of credentials) {
        const binding={ownerId:principal.userId,authorizationId:id,connectionMode:grant.connectionMode,pageId:credential.pageId,authorizationGeneration:grant.generation};
        const expiry=expiresAt && (!grant.expiresAt || expiresAt<grant.expiresAt) ? expiresAt : grant.expiresAt;
        const data={...binding,credentialVersion:version,accessCiphertext:this.vault.encrypt(credential.accessToken,metaPageCredentialContext(binding)),expiresAt:expiry};
        await tx.metaPageCredential.upsert({where:{authorizationId_pageId:{authorizationId:id,pageId:credential.pageId}},create:data,update:{...data,version:{increment:1}}});
      }
      await tx.metaPageCredential.deleteMany({where:{authorizationId:id,pageId:{notIn:credentials.map(c=>c.pageId)}}});
    });
  }
  async resolve(call:SocialProviderCall):Promise<PrivatePageCredential> {
    await call.verifyCurrent();
    if (call.mode!==this.mode || !call.authorizationId || !call.providerUserId || !Number.isSafeInteger(call.authorizationGeneration) ||
      !["FACEBOOK_PAGE","INSTAGRAM_PROFILE"].includes(call.destination.kind))
      fail("CREDENTIAL_UNAVAILABLE",503,"Verified Page credentials are unavailable.");
    const metadata=call.destination.metadata && typeof call.destination.metadata==="object" && !Array.isArray(call.destination.metadata)
      ? call.destination.metadata as Record<string,unknown>:{};
    const pageId=call.destination.kind==="FACEBOOK_PAGE" ? call.destination.externalId : metadata.pageId;
    if (typeof pageId!=="string" || !/^\d{1,64}$/.test(pageId)) fail("CREDENTIAL_UNAVAILABLE",503,"Verified Page credentials are unavailable.");
    const token=await this.db.$transaction(async tx=>{
      const grant=await tx.providerAuthorization.findFirst({where:{id:call.authorizationId,provider:"META",capability:"SOCIAL",status:"CONNECTED",
        providerUserId:call.providerUserId,connectionMode:this.mode.toUpperCase(),generation:call.authorizationGeneration}});
      if (!grant || !grant.accessCiphertext || (grant.expiresAt && grant.expiresAt<=this.now()) ||
        !Array.isArray(grant.scopes) || META_PUBLISHING_SCOPES.some(scope=>!(grant.scopes as string[]).includes(scope)))
        fail("RECONNECT_REQUIRED",409,"Reconnect the Meta publishing account.");
      const destination=await tx.connectionDestination.findFirst({where:{authorizationId:grant.id,kind:call.destination.kind,
        externalId:call.destination.externalId,available:true,selected:true}});
      const saved=destination?.metadata && typeof destination.metadata==="object" && !Array.isArray(destination.metadata)
        ? destination.metadata as Record<string,unknown>:{};
      if (!destination || saved.canWrite!=="ALLOWED" || (destination.kind==="INSTAGRAM_PROFILE" && saved.pageId!==pageId))
        fail("DESTINATION_UNAVAILABLE",409,"Choose an available publishing destination.");
      const row=await tx.metaPageCredential.findFirst({where:{authorizationId:grant.id,pageId,ownerId:grant.userId,
        connectionMode:grant.connectionMode,authorizationGeneration:grant.generation}});
      if (!row || (row.expiresAt && row.expiresAt<=this.now())) fail("CREDENTIAL_UNAVAILABLE",503,"Verified Page credentials are unavailable.");
      return this.vault.decrypt(row.accessCiphertext,metaPageCredentialContext(row));
    });
    await call.verifyCurrent();
    return {pageId,accessToken:token};
  }
}
/** Rotation changes ciphertext only; reconnect generation, Page target and install-version remain intact. */
export async function rotateMetaPageCredentialKeys(db:PrismaClient,vault:CredentialVault) {
  const counts={checked:0,rotated:0,skipped:0,unavailable:0};let cursor:{authorizationId:string;pageId:string}|undefined;
  while (true) {
    const rows=await db.metaPageCredential.findMany({take:100,orderBy:[{authorizationId:"asc"},{pageId:"asc"}],
      ...(cursor ? {where:{OR:[{authorizationId:{gt:cursor.authorizationId}},{authorizationId:cursor.authorizationId,pageId:{gt:cursor.pageId}}]}}:{})});
    if (!rows.length) return counts;
    for (const row of rows) {
      counts.checked++;
      if (row.accessCiphertext.split(".")[1]===vault.activeKeyId) {counts.skipped++;continue;}
      try {
        const context=metaPageCredentialContext(row),plain=vault.decrypt(row.accessCiphertext,context);
        const result=await db.metaPageCredential.updateMany({where:{authorizationId:row.authorizationId,pageId:row.pageId,
          version:row.version,accessCiphertext:row.accessCiphertext},data:{accessCiphertext:vault.encrypt(plain,context),version:{increment:1}}});
        if (result.count===1)counts.rotated++;else counts.skipped++;
      } catch {counts.unavailable++;}
    }
    const last=rows.at(-1)!;cursor={authorizationId:last.authorizationId,pageId:last.pageId};
  }
}
