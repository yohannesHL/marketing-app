import assert from "node:assert/strict";
import { before, after, test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClient } from "@libsql/client";
import { PrismaLibSql } from "@prisma/adapter-libsql";
import { PrismaClient } from "../../apps/web/src/generated/prisma/client";
import { CustomerAuth } from "../../apps/web/src/server/auth/customerAuth";
import { CustomerConnections } from "../../apps/web/src/server/connections/customerConnections";
import { CredentialVault } from "../../apps/web/src/server/security/credentialVault";
import { SocialPostService } from "../../apps/web/src/server/social/postService";
import { SocialDeliveryWorker } from "../../apps/web/src/server/social/deliveryWorker";
import { META_PUBLISHING_SCOPES } from "../../apps/web/src/server/providers/metaPublishing";
import { MetaSocialProvider, metaPublishingRegistration } from "../../apps/web/src/server/social/providers/metaPublishing";
import { SocialProviderRegistry, SocialProviderFailure, type SocialProviderCall, type SocialProviderContext, type SocialProgress } from "../../apps/web/src/server/social/types";
import { applyConnectionMigrations } from "../support/test-database";
import { startMockoon } from "../support/mockoon";
let mock:Awaited<ReturnType<typeof startMockoon>>, directory:string, db:PrismaClient;
const now=()=>new Date("2026-10-13T12:00:00Z");
before(async()=>{mock=await startMockoon("tests/mockoon/meta-publishing.json");directory=await mkdtemp(join(tmpdir(),"meta-social-provider-"));const url=`file:${join(directory,"db.sqlite")}`;const sql=createClient({url});await applyConnectionMigrations(sql);sql.close();db=new PrismaClient({adapter:new PrismaLibSql({url})});});
after(async()=>{await mock?.stop();await db?.$disconnect();if(directory)await rm(directory,{recursive:true,force:true});});
const config=(token="page")=>({appId:"123",appSecret:"fixture-app-secret",configId:"789",redirectUri:"https://app.test/callback",mode:"mock" as const,
 testBaseUrl:mock.origin,mediaOrigin:"https://media.test",now,resolvePageCredential:async()=>({pageId:"111",accessToken:token})});
const counts=async()=>await(await fetch(`${mock.origin}/fixture/counts`)).json();
const reset=async()=>{await fetch(`${mock.origin}/fixture/reset`,{method:"POST"});};
function harness(kind:"FACEBOOK_PAGE"|"INSTAGRAM_PROFILE"="FACEBOOK_PAGE",format:"TEXT"|"IMAGE"|"SHORT_VIDEO"="TEXT",token="page",patch:Partial<SocialProviderCall>={}) {
 const saved:SocialProgress[]=[],events:string[]=[];
 const media=format==='TEXT'?[]:[{id:format==='IMAGE'?'image':'video',url:`https://media.test/api/social/media/${format==='IMAGE'?'image':'video'}/content?expires=2000000000&signature=fixture`,
  mime:format==='IMAGE'?'image/jpeg':'video/mp4',bytes:500000,width:1080,height:format==='IMAGE'?1080:1920,durationMs:format==='IMAGE'?null:30000,
  metadata:{container:format==='IMAGE'?'image/jpeg':'mp4',videoCodec:format==='IMAGE'?'mjpeg':'h264',audioCodec:'aac',fps:30,audioSampleRate:48000}}];
 const call:SocialProviderCall={mode:'mock',accessToken:'social',verifyCurrent:async()=>{events.push('guard');},destination:{kind,externalId:kind==='FACEBOOK_PAGE'?'111':'211',metadata:{}},media,...patch};
 const context:SocialProviderContext={deliveryId:'delivery',revisionId:'revision',content:{title:'Reviewed title',body:'Reviewed caption',format,providerOptions:format==='SHORT_VIDEO'?(kind==='FACEBOOK_PAGE'?{isAigc:false}:{shareToFeed:true}):{}},
  rpc:async(phase,invoke)=>{events.push(phase);return invoke(call);},checkpoint:async(p)=>{saved.push(structuredClone(p));events.push('checkpoint');}};
 return{provider:new MetaSocialProvider(kind,config(token)),context,call,saved,events};
}
test('each Page/IG format retains private progress and uses exactly one final PUBLISH RPC',async()=>{
 for(const [kind,format] of [['FACEBOOK_PAGE','TEXT'],['FACEBOOK_PAGE','IMAGE'],['FACEBOOK_PAGE','SHORT_VIDEO'],['INSTAGRAM_PROFILE','IMAGE'],['INSTAGRAM_PROFILE','SHORT_VIDEO']] as const){
  await reset();const h=harness(kind,format);await h.provider.validate(h.context);const p=await h.provider.prepare(h.context,{});const result=await h.provider.publish(h.context,p);
  assert.equal(result.externalId,kind==='INSTAGRAM_PROFILE'?'701':format==='SHORT_VIDEO'?'501':'111_401');assert.equal(h.events.filter(e=>e==='PUBLISH').length,1);
  assert.equal((await h.provider.status(h.context,h.saved.at(-1)!)).status,'PUBLISHED');const c=await counts();assert.equal(c.feeds+c.reelFinishes+c.igPublishes,1);
  assert.doesNotMatch(JSON.stringify(h.saved),/social"|accessToken|signature=/);
 }
});
test('processing containers and Reel uploads resume saved IDs without creating another resource',async()=>{
 for(const kind of ['FACEBOOK_PAGE','INSTAGRAM_PROFILE'] as const){
  await reset();const h=harness(kind,'SHORT_VIDEO','page-processing');await assert.rejects(h.provider.prepare(h.context,{}),(e:unknown)=>e instanceof SocialProviderFailure&&e.kind==='TRANSIENT'&&e.definitive);
  const progress=h.saved.at(-1)!;assert.ok(progress.videoId||progress.containerId);await assert.rejects(h.provider.prepare(h.context,progress),SocialProviderFailure);
  const c=await counts();assert.equal(c.reelStarts+c.containers,1);assert.equal(c.feeds+c.reelFinishes+c.igPublishes,0);
  const restarted=harness(kind,'SHORT_VIDEO');const ready=await restarted.provider.prepare(restarted.context,progress);await restarted.provider.publish(restarted.context,ready);assert.equal((await counts()).reelStarts+(await counts()).containers,1);
 }
});
test('interruption after initialization saves IDs, while unknown initialization refuses a second create',async()=>{
 await reset();const h=harness('INSTAGRAM_PROFILE','IMAGE');const checkpoint=h.context.checkpoint;
 h.context.checkpoint=async p=>{await checkpoint(p);if(p.containerId)throw new Error('crash');};await assert.rejects(h.provider.prepare(h.context,{}),/crash/);
 const restarted=harness('INSTAGRAM_PROFILE','IMAGE');await restarted.provider.prepare(restarted.context,h.saved.at(-1)!);assert.equal((await counts()).containers,1);
 const marker={...h.saved[0]};await assert.rejects(restarted.provider.prepare(restarted.context,marker),SocialProviderFailure);assert.equal((await counts()).containers,1);
});
test('expired/failed containers, exhausted quotas and unlinked targets never final-publish',async()=>{
 for(const token of ['page-expired-container','page-published-container','page-quota']){
  await reset();const h=harness('INSTAGRAM_PROFILE','IMAGE',token);await assert.rejects(h.provider.prepare(h.context,{}),SocialProviderFailure);assert.equal((await counts()).igPublishes,0);
 }
 const h=harness('INSTAGRAM_PROFILE','IMAGE');const prepared=await h.provider.prepare(h.context,{});
 await assert.rejects(h.provider.publish(h.context,{...prepared,initializedAt:now().getTime()-86400000}),SocialProviderFailure);
 const wrong=harness('INSTAGRAM_PROFILE','IMAGE','page',{destination:{kind:'INSTAGRAM_PROFILE',externalId:'999',metadata:{}}});await assert.rejects(wrong.provider.validate(wrong.context),SocialProviderFailure);
});
test('unknown final publish response stays read-only pending without another media_publish',async()=>{
 await reset();const h=harness('INSTAGRAM_PROFILE','IMAGE','page-unknown-publish');const p=await h.provider.prepare(h.context,{});await assert.rejects(h.provider.publish(h.context,p),(e:unknown)=>e instanceof SocialProviderFailure&&!e.definitive);
 assert.equal((await counts()).igPublishes,1);const restarted=harness('INSTAGRAM_PROFILE','IMAGE','page-published-container');assert.equal((await restarted.provider.status(restarted.context,p)).status,'UNKNOWN');assert.equal((await counts()).igPublishes,1);assert.equal(restarted.events.includes('PUBLISH'),false);
});
test('fresh role/scope/mode and trusted media checks stop provider writes',async()=>{
 for(const patch of [{accessToken:'ads-only'},{accessToken:'role-denied'},{mode:'live' as const}]){const h=harness('FACEBOOK_PAGE','TEXT','page',patch);await assert.rejects(h.provider.validate(h.context),SocialProviderFailure);}
 const url=harness('INSTAGRAM_PROFILE','IMAGE');url.call.media[0].url='https://attacker.test/private';await assert.rejects(url.provider.prepare(url.context,{}),SocialProviderFailure);
 const fps=harness('FACEBOOK_PAGE','SHORT_VIDEO');fps.call.media[0].metadata!.fps=23;await assert.rejects(fps.provider.validate(fps.context),{code:'UNSUPPORTED_CONTENT'});
 const options=harness('INSTAGRAM_PROFILE','SHORT_VIDEO');delete (options.context.content.providerOptions as Record<string,unknown>).shareToFeed;await assert.rejects(options.provider.validate(options.context),{code:'INVALID_PROVIDER_OPTIONS'});
});
test('guard revocation inside a multi-request RPC fences its next HTTP boundary',async()=>{
 await reset();const h=harness('FACEBOOK_PAGE','TEXT');let calls=0;h.call.verifyCurrent=async()=>{if(++calls===3)throw new Error('revoked between HTTP requests');};await assert.rejects(h.provider.validate(h.context),/revoked between HTTP/);assert.equal((await counts()).feeds,0);
});
test('SQLite durable worker persists accepted IDs encrypted and reconciles only reads after processing failure',async()=>{
 await reset();let clock=now();const time=()=>clock,origin='https://app.test';const auth=new CustomerAuth(db,{origin},time),vault=new CredentialVault({test:Buffer.alloc(32,62).toString('base64')},'test');const connections=new CustomerConnections(db,auth,vault,time);
 await auth.provisionCustomer({name:'Meta fixture',email:'meta-social@example.test',password:'synthetic customer password only'});const login=await auth.login('meta-social@example.test','synthetic customer password only');const principal=await auth.requireSession(new Request(origin,{headers:{cookie:login.cookie.split(';')[0]}}));
 const oauth={provider:'META' as const,capability:'SOCIAL' as const,redirectUri:'https://app.test/api/connections/meta-publishing/callback',scopes:[...META_PUBLISHING_SCOPES],pkce:false};const attempt=await connections.beginOAuth(principal,oauth);
 const grant=await connections.completeAuthorization(principal,attempt.state,oauth,{providerUserId:'1001',externalGrantId:'1001',accessToken:'social',scopes:[...META_PUBLISHING_SCOPES],expiresAt:new Date('2026-10-15T12:00:00Z'),connectionMode:'MOCK'});
 const destination=await connections.registerDestination(principal,grant.id,{externalId:'211',name:'Synthetic IG',kind:'INSTAGRAM_PROFILE'});await db.connectionDestination.update({where:{id:destination.id},data:{selected:true,metadata:{canWrite:'ALLOWED',pageId:'111'},lastCheckedAt:time()}});
 // Trusted fixture metadata; separate media-store tests prove actual file probing and ownership.
 const media=await db.socialMediaAsset.create({data:{ownerId:principal.userId,storageKey:'meta-fixture-image',digest:'a'.repeat(64),bytes:500000,mime:'image/jpeg',type:'IMAGE',width:1080,height:1080,status:'AVAILABLE',verifiedAt:time(),metadata:{container:'image/jpeg',videoCodec:'mjpeg',fps:0}}});
 const registry=new SocialProviderRegistry();registry.register(metaPublishingRegistration('INSTAGRAM_PROFILE',{...config('page-post-processing'),now:time}));const flags={mode:'mock' as const,writesEnabled:true,approvedProviders:['META:INSTAGRAM_PROFILE']};const service=new SocialPostService(db,auth,flags,registry,time);
 const post=await service.create(principal,{title:'Meta durable fixture',body:'Reviewed caption',mediaIds:[media.id],variants:[{destinationId:destination.id,format:'IMAGE'}]});await service.approve(principal,post.id,post.revision!.id,[destination.id]);const queued=await service.enqueue(principal,post.id,{revisionId:post.revision!.id,destinationIds:[destination.id],enqueueId:'meta-durable',dueAt:time().toISOString(),timeZone:'UTC'});
 const worker=()=>new SocialDeliveryWorker(db,vault,registry,flags,async({media:assets})=>assets.map(asset=>({id:asset.id,url:`https://media.test/api/social/media/${asset.id}/content?expires=2000000000&signature=fixture`})),time);
 assert.equal((await worker().runOnce())?.status,'UNCERTAIN');const id=queued.deliveries[0].id;const encrypted=await db.socialDeliveryProgress.findUniqueOrThrow({where:{deliveryId:id}});assert.doesNotMatch(encrypted.encryptedState,/701|page-post-processing|social/);
 const progress=JSON.parse(vault.decrypt(encrypted.encryptedState,`social-progress-v1:${id}`));assert.equal(progress.externalId,'701');assert.ok((await db.socialDelivery.findUniqueOrThrow({where:{id}})).publishStartedAt);
 assert.equal(await worker().runOnce(),null);clock=new Date(clock.getTime()+60_000);assert.equal((await worker().reconcileNext())?.status,'UNCERTAIN');assert.equal((await counts()).igPublishes,1);
 registry.register(metaPublishingRegistration('INSTAGRAM_PROFILE',{...config(),now:time}));clock=new Date(clock.getTime()+120_000);assert.equal((await worker().reconcileOnce(id))?.status,'SUCCEEDED');assert.equal((await counts()).igPublishes,1);
 const dto=await service.get(principal,post.id);assert.doesNotMatch(JSON.stringify(dto),/social"|page-post-processing|signature=|uploadUrl|encryptedState/);
});
test('a server-side final submission failure remains ambiguous and status never repeats submission',async()=>{
 await reset();const h=harness('INSTAGRAM_PROFILE','IMAGE','page-server-error');const p=await h.provider.prepare(h.context,{});
 await assert.rejects(h.provider.publish(h.context,p),(e:unknown)=>e instanceof SocialProviderFailure&&e.kind==='TRANSIENT'&&!e.definitive);
 const restarted=harness('INSTAGRAM_PROFILE','IMAGE','page-published-container');assert.equal((await restarted.provider.status(restarted.context,p)).status,'UNKNOWN');assert.equal(restarted.events.includes('PUBLISH'),false);
});
test('registration enforces verified video boundaries and isolates target-bound provider instances',()=>{
 const page=metaPublishingRegistration('FACEBOOK_PAGE',config()),ig=metaPublishingRegistration('INSTAGRAM_PROFILE',config());
 const content={title:'title',body:'caption',format:'SHORT_VIDEO' as const,providerOptions:{isAigc:false}};
 const video={mime:'video/mp4',bytes:1_000_000,width:1080,height:1920,durationMs:90_000,metadata:{container:'mp4',videoCodec:'h264',audioCodec:'aac',fps:24}} as never;
 assert.doesNotThrow(()=>page.validateContent!(content,[video]));assert.throws(()=>page.validateContent!(content,[{...video as object,durationMs:90_001} as never]),{code:'UNSUPPORTED_CONTENT'});
 assert.throws(()=>ig.validateContent!({...content,providerOptions:{shareToFeed:false}},[{...video as object,bytes:300_000_001} as never]),{code:'UNSUPPORTED_CONTENT'});
 assert.notEqual(page.factory(),page.factory());
});
test('stored USER subject binding rejects credentials from a different previously verified grant',async()=>{
 const h=harness('FACEBOOK_PAGE','TEXT','page',{providerUserId:'9999'});await assert.rejects(h.provider.validate(h.context),SocialProviderFailure);
});
test('authoritative quota rejection leaves no unknown-create marker and safely resumes after quota recovery',async()=>{
 await reset();const limited=harness('INSTAGRAM_PROFILE','IMAGE','page-quota');await assert.rejects(limited.provider.prepare(limited.context,{}),SocialProviderFailure);
 assert.equal(limited.saved.at(-1)?.initializationStarted,false);assert.equal((await counts()).containers,0);
 const recovered=harness('INSTAGRAM_PROFILE','IMAGE');const p=await recovered.provider.prepare(recovered.context,limited.saved.at(-1)!);assert.equal(p.containerId,'601');assert.equal((await counts()).containers,1);
});


test("known owned Reel and Instagram container processing failures retain a terminal receipt without another send", async () => {
  for (const kind of ["FACEBOOK_PAGE", "INSTAGRAM_PROFILE"] as const) {
    await reset(); const h = harness(kind, "SHORT_VIDEO");
    await h.provider.validate(h.context); const progress = await h.provider.prepare(h.context, {});
    assert.equal((await fetch(`${mock.origin}/fixture/processing-error`, { method: "POST" })).status, 200);
    assert.deepEqual(await h.provider.status(h.context, progress),
      { status: "FAILED", result: { externalId: kind === "FACEBOOK_PAGE" ? "501" : "601" } });
    const count = await counts(); assert.equal(count.feeds + count.reelFinishes + count.igPublishes, 0);
  }
  await reset();
});
