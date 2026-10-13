import assert from "node:assert/strict";
import { before,after,test } from "node:test";
import { mkdtemp,readFile,writeFile,rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { createClient } from "@libsql/client";
import { PrismaLibSql } from "@prisma/adapter-libsql";
import { PrismaClient } from "../../apps/web/src/generated/prisma/client";
import { CustomerAuth } from "../../apps/web/src/server/auth/customerAuth";
import { CustomerConnections,credentialContext } from "../../apps/web/src/server/connections/customerConnections";
import { CredentialVault } from "../../apps/web/src/server/security/credentialVault";
import { SocialApiBudget } from "../../apps/web/src/server/social/apiBudget";
import { SocialProviderFailure } from "../../apps/web/src/server/social/types";
import { SecurityError } from "../../apps/web/src/server/security/errors";
import { renewXPublishing } from "../../apps/web/src/server/connections/xRenewal";
import { X_SCOPES, XError } from "../../apps/web/src/server/providers/x";
import { applyConnectionMigrations } from "../support/test-database";
import { startMockoon } from "../support/mockoon";
let directory:string,mock:Awaited<ReturnType<typeof startMockoon>>;
const now=()=>new Date("2026-10-13T12:00:00Z"),origin="https://launchpad.test",vault=new CredentialVault({test:Buffer.alloc(32,73).toString("base64")},"test");
function gate(){let release!:()=>void;const promise=new Promise<void>(done=>{release=done;});return {promise,release};}
before(async()=>{
 directory=await mkdtemp(join(tmpdir(),"x-renewal-runtime-"));
 // Extend a private temporary fixture only; frozen shared provider fixtures remain untouched.
 const fixture=JSON.parse(await readFile("tests/mockoon/x.json","utf8")),token=fixture.routes.find((r:any)=>r.endpoint==="2/oauth2/token"),users=fixture.routes.find((r:any)=>r.endpoint==="2/users/me");
 const original=token.responses.find((r:any)=>r.rules.some((rule:any)=>rule.modifier==="refresh_token"&&rule.value==="x-refresh"));
 for(const [refresh,status,access] of [["x-refresh-rate",429,"x-rotated"],["x-refresh-server",500,"x-rotated"],["x-refresh-later-rate",200,"x-later-rate"],["x-refresh-credits",200,"x-credits"]] as const){
  const response=structuredClone(original);response.uuid=randomUUID();response.label="Private renewal regression "+refresh;response.statusCode=status;
  response.rules.find((r:any)=>r.modifier==="refresh_token").value=refresh;response.headers.push({key:"Retry-After",value:"120"});
  response.body=status===200?JSON.stringify({...JSON.parse(original.body),access_token:access}):JSON.stringify({error:status===429?"rate_limit_exceeded":"server_error"});token.responses.unshift(response);
 }
 for(const [access,status] of [["x-later-rate",429],["x-credits",402]] as const){
  const response=structuredClone(users.responses[0]);response.uuid=randomUUID();response.label="Private identity regression "+access;response.statusCode=status;
  response.rules=[{target:"header",modifier:"authorization",operator:"equals",invert:false,value:"Bearer "+access}];response.headers.push({key:"Retry-After",value:"120"});
  response.body=JSON.stringify({title:status===402?"CreditsDepleted":"TooManyRequests",status});users.responses.unshift(response);
 }
 const path=join(directory,"x-private-renewal.json");await writeFile(path,JSON.stringify(fixture));mock=await startMockoon(path);
});
after(async()=>{await mock?.stop();if(directory)await rm(directory,{recursive:true,force:true});});
async function account(name:string,refresh="x-refresh"){
 const path=join(directory,name+".db"),url="file:"+path,sql=createClient({url});await applyConnectionMigrations(sql);sql.close();
 const db=new PrismaClient({adapter:new PrismaLibSql({url})}),auth=new CustomerAuth(db,{origin},now),connections=new CustomerConnections(db,auth,vault,now),password="independent x renewal runtime fixture password";
 await auth.provisionCustomer({name,email:`${name}@example.test`,password});const login=await auth.login(`${name}@example.test`,password),principal=await auth.requireSession(new Request(origin,{headers:{cookie:login.cookie.split(";")[0]}}));
 const oauth={provider:"X" as const,capability:"SOCIAL" as const,scopes:[...X_SCOPES],pkce:true,redirectUri:origin+"/api/connections/x/callback"},attempt=await connections.beginOAuth(principal,oauth);
 const grant=await connections.completeAuthorization(principal,attempt.state,oauth,{providerUserId:"1001",accessToken:"x-access",refreshToken:refresh,scopes:[...X_SCOPES],expiresAt:new Date(now().getTime()+30000),connectionMode:"MOCK"});
 const row=await db.providerAuthorization.findUniqueOrThrow({where:{id:grant.id}}),approval=await db.xConnectionCostApproval.create({data:{id:randomUUID(),kind:"CONNECTION_READ",ownerId:row.userId,sessionId:principal.sessionId,
  authorizationId:row.id,authorizationGeneration:row.generation,credentialVersion:row.credentialVersion,connectionMode:"MOCK",capMicros:10000n,expiresAt:new Date(now().getTime()+600000)}});
 const policy={ownerId:row.userId,mode:"mock" as const,dailyLimitMicros:100000,deliveryLimitMicros:10000,operationCeilings:{USER_READ:10000}};
 const config={clientId:"x-client",clientSecret:"fixture-x-secret",redirectUri:oauth.redirectUri,mockoonEnabled:true,mockoonBaseUrl:mock.origin,now};
 const verifyCurrent=async()=>{
  const current=await db.providerAuthorization.findUniqueOrThrow({where:{id:row.id}});
  if(current.status!=="CONNECTED"||current.generation!==row.generation||current.credentialVersion!==row.credentialVersion)throw new SecurityError("STALE_CREDENTIALS",409,"Grant changed.");
 };
 const fund=(ledger:SocialApiBudget)=>()=>ledger.reserveConnection({approvalId:approval.id,mode:"mock",operation:"USER_READ",costMicros:10000},async tx=>{
  const current=await tx.providerAuthorization.findUniqueOrThrow({where:{id:row.id}}),session=await tx.customerSession.findUnique({where:{id:principal.sessionId}});
  if(current.status!=="CONNECTED"||current.generation!==row.generation||current.credentialVersion!==row.credentialVersion||!session||session.userId!==row.userId||session.expiresAt<=now())
   throw new SecurityError("STALE_CREDENTIALS",409,"Grant or session changed.");
  return {approvalId:approval.id,ownerId:row.userId,sessionId:principal.sessionId,mode:"mock"};
 }).then(()=>{});
 const request={ownerId:row.userId,authorizationId:row.id,generation:row.generation,credentialVersion:row.credentialVersion,verifyCurrent,prefundUserRead:fund(new SocialApiBudget(db,[policy],now))};
 return {db,url,row,approval,policy,config,request,fund,close:()=>db.$disconnect()};
}
test("funding denial releases an unstarted lease and preserves a known unused token for later explicit approval",async()=>{
 const q=await account("x-renew-denied");let sends=0;
 try{
  await assert.rejects(renewXPublishing(q.db,vault,{...q.config,beforeRequest:async()=>{sends++;}},{...q.request,prefundUserRead:q.fund(new SocialApiBudget(q.db,[],now))}),{code:"API_COST_APPROVAL_REQUIRED"});
  assert.equal(sends,0);assert.equal(await q.db.socialCredentialRenewalLease.count(),0);assert.equal(await q.db.socialApiCostReservation.count(),0);
  const old=await q.db.providerAuthorization.findUniqueOrThrow({where:{id:q.row.id}});assert.equal(old.status,"CONNECTED");assert.equal(old.credentialVersion,q.row.credentialVersion);
  assert.equal(vault.decrypt(old.refreshCiphertext!,credentialContext(old.userId,old.id,"refresh")),"x-refresh");
  const grant=await renewXPublishing(q.db,vault,q.config,q.request);assert.equal(grant.refreshToken,"x-refresh-rotated");assert.equal(await q.db.socialApiCostReservation.count(),1);
 }finally{await q.close();}
});
test("one pre-funded coupon covers only the actual identity read; refresh expiry remains unknown and no second cost callback is invoked",async()=>{
 const q=await account("x-renew-coupon"),counts:number[]=[];let funded=0;
 try{
  const grant=await renewXPublishing(q.db,vault,{...q.config,beforeBillableRequest:async()=>{throw new Error("Must not reserve twice");},beforeRequest:async()=>{
   assert.equal(funded,1);const lease=await q.db.socialCredentialRenewalLease.findUniqueOrThrow({where:{authorizationId:q.row.id}});counts.push(lease.requestCount);
  }},{...q.request,prefundUserRead:async()=>{await q.request.prefundUserRead();funded++;}});
  assert.deepEqual(counts,[0,1,2]);assert.equal(funded,1);assert.equal(grant.providerUserId,"1001");assert.equal(grant.refreshExpiresAt,null);
  const costs=await q.db.socialApiCostReservation.findMany();assert.equal(costs.length,1);assert.equal(costs[0].costMicros,10000n);assert.equal(costs[0].connectionApprovalId,q.approval.id);assert.equal(costs[0].deliveryId,null);
  const current=await q.db.providerAuthorization.findUniqueOrThrow({where:{id:q.row.id}});assert.equal(current.refreshExpiresAt,null);assert.equal(current.expiresAt?.getTime(),now().getTime()+7200000);
 }finally{await q.close();}
});
test("two independent clients fund only the winning lease and never rotate twice",{timeout:30000},async()=>{
 const q=await account("x-renew-concurrent"),other=new PrismaClient({adapter:new PrismaLibSql({url:q.url})}),begin=gate(),entered=gate(),finish=gate();let guards=0,funds=0,sends=0;
 const verifyCurrent=async()=>{if(++guards<=2){if(guards===2)begin.release();await begin.promise;}await q.request.verifyCurrent();};
 const request={...q.request,verifyCurrent,prefundUserRead:async()=>{funds++;await q.request.prefundUserRead();}},config={...q.config,beforeRequest:async()=>{if(++sends===1){entered.release();await finish.promise;}}};
 const outcomes=[renewXPublishing(q.db,vault,config,request),renewXPublishing(other,vault,config,request)].map(p=>p.then(value=>({value,error:undefined}),(error:unknown)=>({value:undefined,error})));
 try{
  const loser=await Promise.race(outcomes);assert.ok(loser.error instanceof SocialProviderFailure);assert.equal(loser.error.kind,"TRANSIENT");await entered.promise;assert.equal(funds,1);
  finish.release();const results=await Promise.all(outcomes);assert.equal(results.filter(r=>r.value).length,1);assert.equal(sends,3);assert.equal(await q.db.socialApiCostReservation.count(),1);
 }finally{begin.release();finish.release();await Promise.all(outcomes);await other.$disconnect();await q.close();}
});
test("first token429 retains conservative prefunding and provider Retry-After but does not consume or retry the old rotating token",async()=>{
 const q=await account("x-renew-rate","x-refresh-rate");let sends=0;
 try{
  await assert.rejects(renewXPublishing(q.db,vault,{...q.config,beforeRequest:async()=>{sends++;}},q.request),e=>e instanceof SocialProviderFailure&&e.kind==="RATE_LIMIT"&&e.retryAfterMs===120000);
  assert.equal(sends,1);assert.equal(await q.db.socialCredentialRenewalLease.count(),0);assert.equal((await q.db.providerAuthorization.findUniqueOrThrow({where:{id:q.row.id}})).status,"CONNECTED");
  assert.equal(await q.db.socialApiCostReservation.count(),1);
  await assert.rejects(renewXPublishing(q.db,vault,{...q.config,beforeRequest:async()=>{sends++;}},q.request),{code:"API_COST_LIMIT"});assert.equal(sends,1);
 }finally{await q.close();}
});
test("ambiguous token5xx, later identity429/credits and wrong verified identity reconnect without reusing the old token or refunding allocation",async()=>{
 for(const [name,refresh] of [["server","x-refresh-server"],["later-rate","x-refresh-later-rate"],["credits","x-refresh-credits"],["identity","x-refresh-other"]]){
  const q=await account("x-renew-"+name,refresh);let sends=0;
  try{
   await assert.rejects(renewXPublishing(q.db,vault,{...q.config,beforeRequest:async()=>{sends++;}},q.request),{code:"RECONNECT_REQUIRED"});
   const row=await q.db.providerAuthorization.findUniqueOrThrow({where:{id:q.row.id}});assert.equal(row.status,"RECONNECT_REQUIRED");assert.equal(row.refreshCiphertext,null);
   const marker=await q.db.socialCredentialRenewalLease.findUniqueOrThrow({where:{authorizationId:q.row.id}});assert.equal(marker.requestCount,name==="server"?1:3);
   assert.equal(await q.db.socialApiCostReservation.count(),1);
   await assert.rejects(renewXPublishing(q.db,vault,q.config,q.request),{code:"STALE_CREDENTIALS"});assert.equal(sends,name==="server"?1:3);
  }finally{await q.close();}
 }
});
test("a later caller guard's429 cannot masquerade as a rejected first token exchange",async()=>{
 const q=await account("x-renew-guard-rate");let calls=0;
 try{
  await assert.rejects(renewXPublishing(q.db,vault,{...q.config,beforeRequest:async()=>{if(++calls===2)throw new XError("PROVIDER_RATE_LIMITED",429,true,false,120000);}},q.request),{code:"RECONNECT_REQUIRED"});
  assert.equal(calls,2);const current=await q.db.providerAuthorization.findUniqueOrThrow({where:{id:q.row.id}});assert.equal(current.status,"RECONNECT_REQUIRED");assert.equal(current.refreshCiphertext,null);
  assert.equal(await q.db.socialApiCostReservation.count(),1);
 }finally{await q.close();}
});
