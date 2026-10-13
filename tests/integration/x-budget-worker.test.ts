import assert from "node:assert/strict";
import { before, after, test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClient } from "@libsql/client";
import { PrismaLibSql } from "@prisma/adapter-libsql";
import { PrismaClient } from "../../apps/web/src/generated/prisma/client";
import { CustomerAuth } from "../../apps/web/src/server/auth/customerAuth";
import { CustomerConnections, credentialContext } from "../../apps/web/src/server/connections/customerConnections";
import { CredentialVault } from "../../apps/web/src/server/security/credentialVault";
import { SocialApiBudget, type ApiBudgetOwnerPolicy } from "../../apps/web/src/server/social/apiBudget";
import { SocialDeliveryWorker } from "../../apps/web/src/server/social/deliveryWorker";
import { SocialPostService } from "../../apps/web/src/server/social/postService";
import { SocialProviderRegistry } from "../../apps/web/src/server/social/types";
import { xSocialRegistration } from "../../apps/web/src/server/social/providers/x";
import { X_SCOPES, type XPriceSchedule } from "../../apps/web/src/server/providers/x";
import { renewXPublishing } from "../../apps/web/src/server/connections/xRenewal";
import { applyConnectionMigrations } from "../support/test-database";
import { startMockoon } from "../support/mockoon";
let directory: string, db: PrismaClient, mock: Awaited<ReturnType<typeof startMockoon>>;
const prices: XPriceSchedule = { USER_READ:10000,POST_READ:5000,POST_CREATE:15000,POST_CREATE_URL:200000,POST_DELETE:10000,
 MEDIA_UPLOAD:1000,MEDIA_INIT:1000,MEDIA_APPEND:1000,MEDIA_FINALIZE:1000,MEDIA_STATUS:1000 };
const vault = new CredentialVault({ test: Buffer.alloc(32, 58).toString("base64") }, "test"), origin = "https://launchpad.test";
before(async () => {
 mock = await startMockoon("tests/mockoon/x.json"); directory = await mkdtemp(join(tmpdir(), "x-budget-worker-"));
 const url = `file:${join(directory,"test.db")}`, sql = createClient({ url }); await applyConnectionMigrations(sql); sql.close();
 db = new PrismaClient({ adapter: new PrismaLibSql({ url }) });
});
after(async () => { await mock?.stop(); await db?.$disconnect(); if(directory) await rm(directory,{recursive:true,force:true}); });
async function job(name:string,body="Fixture worker",cap=100000,options:{daily?:number;delivery?:number;clock?:string}={}) {
 let clock = new Date(options.clock??"2026-10-13T12:00:00Z"); const now=()=>new Date(clock);
 const auth=new CustomerAuth(db,{origin},now),connections=new CustomerConnections(db,auth,vault,now),password="independent x budget worker fixture password";
 await auth.provisionCustomer({email:`${name}@example.test`,name,password}); const login=await auth.login(`${name}@example.test`,password);
 const principal=await auth.requireSession(new Request(origin,{headers:{cookie:login.cookie.split(";")[0]}}));
 const oauth={provider:"X" as const,capability:"SOCIAL" as const,pkce:true,scopes:[...X_SCOPES],redirectUri:`${origin}/api/connections/x/callback`};
 const attempt=await connections.beginOAuth(principal,oauth), grant=await connections.completeAuthorization(principal,attempt.state,oauth,{providerUserId:"1001",accessToken:"x-access",
  refreshToken:"x-refresh",scopes:[...X_SCOPES],expiresAt:new Date(clock.getTime()+7200000),connectionMode:"MOCK"});
 const destination=await connections.registerDestination(principal,grant.id,{kind:"X_PROFILE",externalId:"1001",name:"Fixture X profile"});
 await db.connectionDestination.update({where:{id:destination.id},data:{selected:true,metadata:{canRead:true,canWrite:"ALLOWED"}}});
 const config={clientId:"x-client",clientSecret:"fixture-x-secret",redirectUri:oauth.redirectUri,mockoonEnabled:true,mockoonBaseUrl:mock.origin,now};
 const registry=new SocialProviderRegistry();registry.register(xSocialRegistration(config,{mediaOrigin:mock.origin,prices,now}));
 const workerConfig={mode:"mock" as const,writesEnabled:true,approvedProviders:["X:X_PROFILE"],leaseMs:30000,maxAttempts:5};
 const service=new SocialPostService(db,auth,workerConfig,registry,now),post=await service.create(principal,{title:name,body,mediaIds:[],
  variants:[{destinationId:destination.id,format:"TEXT",providerOptions:{madeWithAi:false,paidPartnership:false,maxApiCostMicros:cap}}]});
 await service.approve(principal,post.id,post.revision!.id,[destination.id]);
 const queued=await service.enqueue(principal,post.id,{revisionId:post.revision!.id,destinationIds:[destination.id],enqueueId:name,dueAt:now().toISOString(),timeZone:"UTC"});
 const policy:ApiBudgetOwnerPolicy={ownerId:principal.userId,mode:"mock",dailyLimitMicros:options.daily??1000000,deliveryLimitMicros:options.delivery??cap,operationCeilings:prices};
 const ledger=new SocialApiBudget(db,[policy],now);
 const worker=(budget:SocialApiBudget|undefined=ledger)=>new SocialDeliveryWorker(db,vault,registry,workerConfig,undefined,now,undefined,budget);
 const progress=async()=>{
  const row=await db.socialDeliveryProgress.findUniqueOrThrow({where:{deliveryId:queued.deliveries[0].id}});
  return JSON.parse(vault.decrypt(row.encryptedState,`social-progress-v1:${row.deliveryId}`));
 };
 return {principal,grant,destination,post,queued,policy,ledger,worker,registry,workerConfig,config,progress,now,advance:(ms:number)=>{clock=new Date(clock.getTime()+ms);}};
}
const allocations=(id:string)=>db.socialApiCostReservation.findMany({where:{deliveryId:id},orderBy:{createdAt:"asc"}});

test("budget denial at the actual create boundary is BLOCKED with retained reads and no ambiguous create checkpoint",async()=>{
 const q=await job("x-worker-budget-before","Fixture worker",100000,{delivery:40000}), id=q.queued.deliveries[0].id;
 const outcome=await q.worker().runOnce();assert.equal(outcome?.status,"BLOCKED");
 const row=await db.socialDelivery.findUniqueOrThrow({where:{id}});assert.equal(row.errorCode,"API_COST_LIMIT");assert.equal(row.publishStartedAt,null);
 const costs=await allocations(id);assert.deepEqual(costs.map(c=>c.operation),["USER_READ","USER_READ","USER_READ"]);
 assert.equal(costs.reduce((n,c)=>n+c.costMicros,0n),30000n);assert.equal((await q.progress()).createAttempted,false);
 assert.equal((await(await fetch(mock.origin+"/fixture/metrics")).json()).worker,"");
});
test("worker renewal prefunds from the same immutable review and adopts the persisted rotated version before later sends",async()=>{
 const q=await job("x-worker-renewal","Fixture credits"),id=q.queued.deliveries[0].id;
 await db.providerAuthorization.update({where:{id:q.grant.id},data:{expiresAt:new Date(q.now().getTime()+30000)}});
 const worker=new SocialDeliveryWorker(db,vault,q.registry,q.workerConfig,undefined,q.now,request=>renewXPublishing(db,vault,q.config,{
  ownerId:request.ownerId,authorizationId:request.authorizationId,generation:request.authorizationGeneration,credentialVersion:request.credentialVersion,
  verifyCurrent:request.verifyCurrent,prefundUserRead:()=>request.authorizeApiCost!({operation:"USER_READ",costMicros:prices.USER_READ,maxApiCostMicros:request.maxApiCostMicros!}),
 }),q.ledger);
 assert.equal((await worker.runOnce())?.status,"BLOCKED");const costs=await allocations(id);
 assert.deepEqual(costs.map(c=>c.operation),["USER_READ","USER_READ","USER_READ","USER_READ","POST_CREATE"]);
 assert.equal(costs[0].credentialVersion,q.grant.credentialVersion);assert.ok(costs.slice(1).every(c=>c.credentialVersion===q.grant.credentialVersion+1));
 assert.ok(costs.every(c=>c.revisionId===q.post.revision!.id&&c.reviewedCapMicros===100000n));
 const current=await db.providerAuthorization.findUniqueOrThrow({where:{id:q.grant.id}});assert.equal(current.status,"CONNECTED");assert.equal(current.credentialVersion,q.grant.credentialVersion+1);
 assert.equal(current.refreshExpiresAt,null);assert.equal(vault.decrypt(current.refreshCiphertext!,credentialContext(current.userId,current.id,"refresh")),"x-refresh-rotated");
});
test("every actual X worker HTTP gets a fenced immutable allocation; successful receipt readback totals the reviewed estimate",async()=>{
 const q=await job("x-worker-success"),id=q.queued.deliveries[0].id,outcome=await q.worker().runOnce();assert.equal(outcome?.status,"SUCCEEDED");
 assert.equal(outcome?.externalId,"6005");const costs=await allocations(id);
 assert.deepEqual(costs.map(c=>c.operation),["USER_READ","USER_READ","USER_READ","POST_CREATE","POST_READ"]);
 assert.equal(costs.reduce((n,c)=>n+c.costMicros,0n),50000n);
 for(const cost of costs){assert.equal(cost.ownerId,q.principal.userId);assert.equal(cost.revisionId,q.post.revision!.id);assert.equal(cost.authorizationId,q.grant.id);
  assert.equal(cost.authorizationGeneration,1);assert.equal(cost.credentialVersion,q.grant.credentialVersion);assert.match(cost.leaseHash!,/^[a-f0-9]{64}$/);assert.equal(cost.reviewedCapMicros,100000n);}
 assert.doesNotMatch(JSON.stringify(outcome),/x-access|x-refresh|Ciphertext|leaseHash/);
});
test("accepted post followed by read funding denial stays UNCERTAIN and reconciliation funds only known receipt read",async()=>{
 const q=await job("x-worker-read-cap","Fixture text",50000,{delivery:45000}),id=q.queued.deliveries[0].id;
 assert.equal((await q.worker().runOnce())?.status,"UNCERTAIN");const saved=await q.progress();assert.equal(saved.postId,"6001");assert.equal(saved.createAttempted,true);
 assert.equal((await allocations(id)).reduce((n,c)=>n+c.costMicros,0n),45000n);
 const renewedPolicy={...q.policy,deliveryLimitMicros:50000};q.advance(60000);
 const result=await q.worker(new SocialApiBudget(db,[renewedPolicy],q.now)).reconcileOnce(id);assert.equal(result?.status,"SUCCEEDED");assert.equal(result?.externalId,"6001");
 const costs=await allocations(id);assert.equal(costs.filter(c=>c.operation==="POST_CREATE").length,1);assert.equal(costs.reduce((n,c)=>n+c.costMicros,0n),50000n);
});
test("known credit rejection blocks before publication; ambiguous create retains allocations and cannot create again",async()=>{
 const credits=await job("x-worker-credits","Fixture credits"),cid=credits.queued.deliveries[0].id;
 const rejected=await credits.worker().runOnce();assert.equal(rejected?.status,"BLOCKED");assert.equal((await db.socialDelivery.findUniqueOrThrow({where:{id:cid}})).errorCode,"PROVIDER_CREDITS_REQUIRED");
 assert.equal((await credits.progress()).createAttempted,false);assert.equal((await allocations(cid)).reduce((n,c)=>n+c.costMicros,0n),45000n);
 const unknown=await job("x-worker-unknown","Fixture ambiguous"),uid=unknown.queued.deliveries[0].id;
 assert.equal((await unknown.worker().runOnce())?.status,"UNCERTAIN");const before=await allocations(uid);unknown.advance(60000);
 assert.equal((await unknown.worker().reconcileOnce(uid))?.status,"UNCERTAIN");const after=await allocations(uid);
 assert.equal(after.length,before.length);assert.equal(after.filter(c=>c.operation==="POST_CREATE").length,1);assert.equal((await unknown.progress()).createAttempted,true);
});
test("retry and a new UTC day never reset the immutable delivery allocation cap",async()=>{
 const q=await job("x-worker-rate","Fixture rate",100000,{clock:"2026-10-13T23:59:30Z"}),id=q.queued.deliveries[0].id;
 assert.equal((await q.worker().runOnce())?.status,"RETRY_WAIT");q.advance(60000);
 assert.equal((await q.worker().runOnce())?.status,"RETRY_WAIT");q.advance(60000);
 assert.equal((await q.worker().runOnce())?.status,"BLOCKED");const costs=await allocations(id);
 assert.equal(costs.filter(c=>c.operation==="POST_CREATE").length,2);assert.equal(costs.reduce((n,c)=>n+c.costMicros,0n),100000n);
 assert.equal(await db.socialApiBudgetWindow.count({where:{ownerId:q.principal.userId}}),2);
 assert.equal((await db.socialDelivery.findUniqueOrThrow({where:{id}})).errorCode,"API_COST_LIMIT");
});
test("missing owner policy or ledger denies before billable HTTP and a revoke after allocation never refunds the estimate",async()=>{
 const noPolicy=await job("x-worker-no-policy");assert.equal((await noPolicy.worker(new SocialApiBudget(db,[],noPolicy.now)).runOnce())?.status,"BLOCKED");
 assert.equal((await allocations(noPolicy.queued.deliveries[0].id)).length,0);
 const noLedger=await job("x-worker-no-ledger");
 const empty=new SocialDeliveryWorker(db,vault,noLedger.registry,noLedger.workerConfig,undefined,noLedger.now);
 assert.equal((await empty.runOnce())?.status,"BLOCKED");assert.equal((await allocations(noLedger.queued.deliveries[0].id)).length,0);
 const q=await job("x-worker-revoke-after"),id=q.queued.deliveries[0].id;
 class RevokingBudget extends SocialApiBudget { async reserve(input:Parameters<SocialApiBudget["reserve"]>[0],verify:Parameters<SocialApiBudget["reserve"]>[1]) {
  const result=await super.reserve(input,verify);await db.providerAuthorization.update({where:{id:q.grant.id},data:{credentialVersion:{increment:1}}});return result;
 }}
 assert.equal((await q.worker(new RevokingBudget(db,[q.policy],q.now)).runOnce())?.status,"BLOCKED");assert.equal((await allocations(id)).reduce((n,c)=>n+c.costMicros,0n),10000n);
});
