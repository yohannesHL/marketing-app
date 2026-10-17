import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClient } from "@libsql/client";
import { applyConnectionMigrations } from "../support/test-database";
import { PrismaClient } from "../../apps/web/src/generated/prisma/client";
import { LocalSqliteAdapter } from "../../apps/web/src/server/prisma/localSqliteAdapter";
import { CustomerAuth } from "../../apps/web/src/server/auth/customerAuth";
import { WorkspaceService } from "../../apps/web/src/server/workspace/service";
import { createWorkspaceApi } from "../../apps/web/src/server/workspace/api";
import { assistantSettings, creativeFormats, gatewayEndpoint, CampaignAiAssistant } from "../../apps/web/src/server/workspace/assistant";
import { reserveAiRequest } from "../../apps/web/src/server/workspace/aiQuota";
import { campaignFromDTO } from "../../apps/web/src/components/workspace/campaignBuilderState";
import type { BrandDTO, CampaignInput } from "../../apps/web/src/server/workspace/types";

const origin = "https://ai.test";
const campaign: CampaignInput = { type:"SOCIAL",name:"Ceramic studio",websiteUrl:"https://example.test/studio",brief:"Invite local visitors to meet the makers at our ceramic studio on Saturday.",goal:"awareness",audience:"Local residents",platforms:["YOUTUBE","LINKEDIN","X"],plan:{},creatives:[],socialPostIds:[],status:"DRAFT" };
const brand: BrandDTO = {version:0,name:"Studio",websiteUrl:"",voice:"Warm and specific",audience:"Residents",colors:[],rules:"No invented discounts",logoUrl:"",updatedAt:null};
const generated = campaign.platforms.map(platform=>({platform,format:creativeFormats[platform],title:`Meet our makers on ${platform}`,body:`Visit the studio this Saturday. ${platform}`,cta:"Meet us",script:platform==="YOUTUBE"?"Open on the potter's wheel. Introduce the maker. Invite visitors.":"",visualBrief:platform==="YOUTUBE"?"Vertical close-up of pottery in progress.":""}));
const response = (output:unknown) => Response.json({status:"completed",output:[{type:"message",content:[{type:"output_text",text:JSON.stringify(output)}]}]});
function assistant(output:unknown, onRequest?:(url:unknown,init:RequestInit)=>void) {
 return new CampaignAiAssistant({mode:"openai",apiKey:"synthetic-test-key",model:"test-model",fetch:async(url,init)=>{onRequest?.(url,init!);return response(output);}});
}
let directory:string,dbUrl:string,db:PrismaClient,auth:CustomerAuth,cookie:string,ownerId:string;
before(async()=>{
 directory=await mkdtemp(join(tmpdir(),"workspace-ai-"));const url=`file:${join(directory,"db.sqlite")}`;dbUrl=url;const client=createClient({url});await applyConnectionMigrations(client);client.close();
 db=new PrismaClient({adapter:new LocalSqliteAdapter({url})});auth=new CustomerAuth(db,{origin});
 const user=await auth.provisionCustomer({email:"ai@example.test",name:"AI test",password:"SyntheticPassword!2026"});ownerId=user.id;cookie=(await auth.login("ai@example.test","SyntheticPassword!2026")).cookie.split(";")[0];
});
after(async()=>{await db?.$disconnect();if(directory)await rm(directory,{recursive:true,force:true});});
function request(body:unknown,headers:Record<string,string>={}) {return new Request(`${origin}/api/workspace/assist`,{method:"POST",headers:{origin,cookie,"content-type":"application/json",...headers},body:JSON.stringify(body)});}
function input(){const {socialPostIds,status,...value}=campaign;return value;}

test("real AI uses Responses structured output, bounded server settings, own brand context and never publishes",async()=>{
 let calls=0;
 await db.brandKit.create({data:{ownerId,name:"Owner brand",voice:"Owner voice",rules:"Owner-only rule",audience:"Residents",websiteUrl:"",logoUrl:"",colors:[]}});
 const service=new WorkspaceService(db,"openai",assistant({creatives:generated},(url,init)=>{
  calls++;assert.equal(url,"https://api.openai.com/v1/responses");assert.equal(init.redirect,"error");assert.equal(new Headers(init.headers).get("authorization"),"Bearer synthetic-test-key");
  const body=JSON.parse(init.body as string);assert.equal(body.store,false);assert.equal(body.max_output_tokens,8000);assert.equal(body.text.format.strict,true);assert.equal(body.model,"test-model");assert.equal(body.tools,undefined);
  const context=JSON.parse(body.input[0].content);assert.equal(context.brand.rules,"Owner-only rule");assert.deepEqual(context.campaign.platforms,campaign.platforms);assert.equal(context.campaign.creatives,undefined);assert.equal(context.brand.ownerId,undefined);
 }));
 const api=createWorkspaceApi(auth,service);const beforePosts=await db.socialPost.count();
 const result=await api(request({action:"CREATIVES",campaign:input()}));assert.equal(result.status,200);assert.equal(result.headers.get("cache-control"),"no-store");
 const data=await result.json();assert.equal(data.mode,"openai");assert.deepEqual(data.creatives,generated);assert.equal(calls,1);assert.equal(await db.socialPost.count(),beforePosts);assert.equal(await db.socialDelivery.count(),0);assert.equal(await db.workspaceCampaign.count(),0);
 const saved=await service.create(await auth.requireSession(request({})),{...input(),creatives:data.creatives});
 assert.equal(campaignFromDTO(saved).creatives[0].script,generated[0].script);assert.equal(campaignFromDTO(saved).creatives[0].visualBrief,generated[0].visualBrief);
});

test("auth, origin, invalid context and missing key fail before any provider call",async()=>{
 let calls=0;const api=createWorkspaceApi(auth,new WorkspaceService(db,"openai",assistant({brief:"Enhanced"},()=>{calls++;})));
 assert.equal((await api(request({action:"BRIEF",campaign:input()},{cookie:""}))).status,401);
 assert.equal((await api(request({action:"BRIEF",campaign:input()},{origin:"https://evil.test"}))).status,403);
 for(const value of [{...input(),ownerId:"other"},{...input(),platforms:["OTHER"]},{...input(),brief:""}]) assert.equal((await api(request({action:"BRIEF",campaign:value}))).status,400);
 assert.equal((await api(request({action:"PUBLISH",campaign:input()}))).status,400);assert.equal(calls,0);
 const missing=createWorkspaceApi(auth,new WorkspaceService(db,"openai",new CampaignAiAssistant({mode:"openai",apiKey:""})));
 assert.equal((await missing(request({action:"BRIEF",campaign:input()}))).status,503);
});

test("mode selection separates real AI from Mockoon connections and fails closed",()=>{
 assert.deepEqual(assistantSettings({CONNECTION_MODE:"mock",WORKSPACE_AI_MODE:"openai",OPENAI_API_KEY:"test"}),{mode:"openai",available:true});
 assert.deepEqual(assistantSettings({WORKSPACE_AI_MODE:"openai"}),{mode:"openai",available:false});
 assert.deepEqual(assistantSettings({WORKSPACE_AI_MODE:"invalid",OPENAI_API_KEY:"test"}),{mode:"disabled",available:false});
 assert.deepEqual(assistantSettings({CONNECTION_MODE:"mock"}),{mode:"mock",available:true});
});

test("provider refusals, incomplete/malformed output, duplicate channels and unsafe lengths never reach drafts",async()=>{
 const invalid=[{creatives:[generated[0],generated[0],generated[2]]},{creatives:[...generated,{...generated[0],platform:"META"}]},{creatives:generated.map((v,i)=>i===2?{...v,body:"界".repeat(200)}:v)},{creatives:generated.map((v,i)=>i===0?{...v,title:"a".repeat(101)}:v)},{creatives:generated.map((v,i)=>i===0?{...v,format:"TEXT"}:v)}];
 for(const output of invalid)await assert.rejects(()=>assistant(output).generate("CREATIVES",campaign,brand),{code:"AI_INVALID_OUTPUT"});
 await assert.rejects(()=>assistant({brief:" "}).generate("BRIEF",campaign,brand),{code:"AI_INVALID_OUTPUT"});
 for(const payload of [{status:"incomplete",output:[]},{status:"completed",output:[{type:"message",content:[{type:"output_text",text:"not json"}]}]}]){
  const adapter=new CampaignAiAssistant({mode:"openai",apiKey:"test",fetch:async()=>Response.json(payload)});await assert.rejects(()=>adapter.generate("BRIEF",campaign,brand),{code:"AI_INVALID_OUTPUT"});
 }
 const refused=new CampaignAiAssistant({mode:"openai",apiKey:"test",fetch:async()=>Response.json({status:"completed",output:[{type:"message",content:[{type:"refusal",refusal:"private reason"}]}]})});
 await assert.rejects(()=>refused.generate("BRIEF",campaign,brand),{code:"AI_REFUSED"});
});

test("provider errors and oversized responses do not expose credentials or provider bodies",async()=>{
 for(const status of [401,429,500]){
  const adapter=new CampaignAiAssistant({mode:"openai",apiKey:"test",fetch:async()=>new Response("secret-provider-error",{status})});
  await assert.rejects(()=>adapter.generate("BRIEF",campaign,brand),(e:any)=>e.status===(status===429?429:503)&&!e.message.includes("secret"));
 }
 const huge=new CampaignAiAssistant({mode:"openai",apiKey:"test",fetch:async()=>new Response("x".repeat(140000))});await assert.rejects(()=>huge.generate("BRIEF",campaign,brand),{code:"AI_INVALID_OUTPUT"});
 const timeout=new CampaignAiAssistant({mode:"openai",apiKey:"test",timeoutMs:5,fetch:async(_url,options)=>new Promise((_resolve,reject)=>{options!.signal!.addEventListener("abort",()=>reject(new Error("secret timeout")),{once:true});setTimeout(()=>reject(new Error("secret timeout")),25);})});
 await assert.rejects(()=>timeout.generate("BRIEF",campaign,brand),(e:any)=>e.status===503&&!e.message.includes("secret"));
});

test("durable owner quotas reject excess requests and reset only with the window",async()=>{
 const now=new Date("2030-01-01T12:00:00Z");const env={AI_MINUTE_REQUEST_LIMIT:"2",AI_DAILY_REQUEST_LIMIT:"3"};
 await reserveAiRequest(db,ownerId,now,env);await reserveAiRequest(db,ownerId,now,env);
 await assert.rejects(()=>reserveAiRequest(db,ownerId,now,env),{code:"AI_USAGE_LIMIT"});
 await reserveAiRequest(db,ownerId,new Date(now.getTime()+60000),env);
 await assert.rejects(()=>reserveAiRequest(db,ownerId,new Date(now.getTime()+120000),env),{code:"AI_USAGE_LIMIT"});
 const peer=await auth.provisionCustomer({email:"peer@example.test",name:"Peer",password:"SyntheticPassword!2026"});await reserveAiRequest(db,peer.id,now,env);
 await reserveAiRequest(db,ownerId,new Date(now.getTime()+86400000),env);
});


test("two independent clients cannot reserve the last AI slot twice",async()=>{
 const peer=await auth.provisionCustomer({email:"race@example.test",name:"Race",password:"SyntheticPassword!2026"});
 const second=new PrismaClient({adapter:new LocalSqliteAdapter({url:dbUrl})});
 const now=new Date("2030-02-01T12:00:00Z"),env={AI_MINUTE_REQUEST_LIMIT:"1",AI_DAILY_REQUEST_LIMIT:"1"};
 try{
  const results=await Promise.allSettled([reserveAiRequest(db,peer.id,now,env),reserveAiRequest(second,peer.id,now,env)]);
  assert.equal(results.filter(r=>r.status==="fulfilled").length,1);
  assert.equal((await db.aiRequestWindow.findMany({where:{ownerId:peer.id}})).every(r=>r.count===1),true);
 }finally{await second.$disconnect();}
});

test("AI failures consume a durable request and an exhausted owner never contacts the provider",async()=>{
 const user=await auth.provisionCustomer({email:"limit@example.test",name:"Limited",password:"SyntheticPassword!2026"});
 const session=(await auth.login("limit@example.test","SyntheticPassword!2026")).cookie.split(";")[0];
 let calls=0;const adapter=new CampaignAiAssistant({mode:"openai",apiKey:"test",fetch:async()=>{calls++;throw new Error("network failure");}});
 const api=createWorkspaceApi(auth,new WorkspaceService(db,"openai",adapter));
 const initial=await api(request({action:"BRIEF",campaign:input()},{cookie:session}));assert.equal(initial.status,503);assert.equal(calls,1);
 const rows=await db.aiRequestWindow.findMany({where:{ownerId:user.id}});assert.equal(rows.length,2);assert.ok(rows.every(r=>r.count===1));
 await db.aiRequestWindow.updateMany({where:{ownerId:user.id},data:{count:1000}});
 const denied=await api(request({action:"BRIEF",campaign:input()},{cookie:session}));assert.equal(denied.status,429);assert.equal(calls,1);
});

test("AI brief enhancement includes only the authenticated customer's brand rules",async()=>{
 const user=await auth.provisionCustomer({email:"brand-peer@example.test",name:"Brand peer",password:"SyntheticPassword!2026"});
 await db.brandKit.create({data:{ownerId:user.id,name:"Peer brand",voice:"Peer voice",rules:"PEER_PRIVATE_RULE",audience:"",websiteUrl:"",logoUrl:"",colors:[]}});
 const session=(await auth.login("brand-peer@example.test","SyntheticPassword!2026")).cookie.split(";")[0];
 let context:any;
 const api=createWorkspaceApi(auth,new WorkspaceService(db,"openai",assistant({brief:"Invite residents to meet the ceramic makers this Saturday."},(_url,init)=>{context=JSON.parse(JSON.parse(init.body as string).input[0].content);})));
 const result=await api(request({action:"BRIEF",campaign:input()},{cookie:session}));assert.equal(result.status,200);assert.equal(context.brand.rules,"PEER_PRIVATE_RULE");assert.ok(!JSON.stringify(context).includes("Owner-only rule"));
 assert.equal((await result.json()).brief,"Invite residents to meet the ceramic makers this Saturday.");
});


test("llm-gw uses the Codex chat contract without unsupported controls and retains review-only semantics", async () => {
 let calls = 0;
 const adapter = new CampaignAiAssistant({ mode: "llm-gw", apiKey: "gateway-test-key", baseUrl: "http://127.0.0.1:4000", model: "codex/fast", fetch: async (url, init) => {
  calls++;
  assert.equal(url, "http://127.0.0.1:4000/v1/chat/completions");
  assert.equal(new Headers(init!.headers).get("authorization"), "Bearer gateway-test-key");
  assert.equal(init!.redirect, "error");
  const wire = JSON.parse(init!.body as string);
  assert.deepEqual(Object.keys(wire).sort(), ["messages", "model", "response_format"]);
  assert.equal(wire.model, "codex/fast");
  assert.equal(wire.messages[0].role, "system");
  assert.equal(wire.response_format.type, "json_schema");
  assert.equal(wire.response_format.json_schema.strict, true);
  const context = JSON.parse(wire.messages[1].content);
  assert.equal(context.brand.rules, "Owner-only rule");
  return Response.json({choices: [{finish_reason: "stop", message: {role: "assistant", content: JSON.stringify(context.action === "BRIEF" ? {brief: "Invite residents to meet the makers on Saturday."} : {creatives: generated})}}]});
 }});
 const api = createWorkspaceApi(auth, new WorkspaceService(db, "llm-gw", adapter));
 const beforePosts = await db.socialPost.count();
 for (const action of ["BRIEF", "CREATIVES"]) {
  const result = await api(request({action, campaign: input()}));
  assert.equal(result.status, 200);
  const body = await result.json(); assert.equal(body.mode, "llm-gw");
  if (action === "CREATIVES") assert.deepEqual(body.creatives, generated);
  else assert.match(body.brief, /residents/);
 }
 assert.equal(calls, 2); assert.equal(await db.socialPost.count(), beforePosts); assert.equal(await db.socialDelivery.count(), 0);
});

test("gateway configuration accepts root or v1 bases, requires credentials and rejects unsafe URLs", async () => {
 for (const suffix of ["", "/", "/v1", "/v1/"]) assert.equal(gatewayEndpoint(`http://127.0.0.1:4000${suffix}`), "http://127.0.0.1:4000/v1/chat/completions");
 for (const base of ["file:///etc/passwd", "http://remote.test", "https://user:secret@example.test", "https://example.test/?key=secret", "https://example.test/#x", "https://example.test/other"]) {
  assert.equal(gatewayEndpoint(base), null);
  let called = false;
  const adapter = new CampaignAiAssistant({mode: "llm-gw", baseUrl: base, apiKey: "test", fetch: async () => {called = true; return response({brief:"No"});}});
  assert.equal(adapter.configured(), false);
  await assert.rejects(() => adapter.generate("BRIEF", campaign, brand), {code:"AI_CONFIG_INVALID"});
  assert.equal(called, false);
 }
 assert.deepEqual(assistantSettings({LLM_BASE_URL:"http://127.0.0.1:4000", LLM_MODEL:"codex/fast", LLM_API_KEY:"test", CONNECTION_MODE:"mock"}), {mode:"llm-gw", available:true});
 assert.deepEqual(assistantSettings({WORKSPACE_AI_MODE:"llm-gw"}), {mode:"llm-gw", available:false});
 assert.deepEqual(assistantSettings({WORKSPACE_AI_MODE:"mock", LLM_BASE_URL:"http://127.0.0.1:4000"}), {mode:"mock", available:true});
});

test("gateway rejects truncated, refused, tool-based and malformed completions without applying output", async () => {
 const validMessage = {content: JSON.stringify({brief:"Enhanced brief"})};
 for (const payload of [
  {choices:[]}, {choices:[{finish_reason:"length", message:validMessage}]},
  {choices:[{finish_reason:"stop", message:{content:"not json"}}]},
  {choices:[{finish_reason:"stop", message:{...validMessage, tool_calls:[]}}]},
  {choices:[{finish_reason:"stop", message:{content:JSON.stringify({creatives:[generated[0], generated[0], generated[2]]})}}]},
 ]) {
  const adapter = new CampaignAiAssistant({mode:"llm-gw", apiKey:"test", fetch:async()=>Response.json(payload)});
  await assert.rejects(()=>adapter.generate("CREATIVES",campaign,brand), {code:"AI_INVALID_OUTPUT"});
 }
 const adapter = new CampaignAiAssistant({mode:"llm-gw", apiKey:"test", fetch:async()=>Response.json({choices:[{finish_reason:"stop",message:{refusal:"private provider reason"}}]})});
 await assert.rejects(()=>adapter.generate("BRIEF",campaign,brand), {code:"AI_REFUSED"});
});


test("gateway authentication failure makes one request and never falls back to another provider", async () => {
 let calls = 0;
 const adapter = new CampaignAiAssistant({mode:"llm-gw", apiKey:"synthetic-rejected-key", baseUrl:"http://127.0.0.1:4000", fetch:async (url) => {
  calls++; assert.equal(url, "http://127.0.0.1:4000/v1/chat/completions");
  return new Response("private gateway diagnostic", {status:401});
 }});
 await assert.rejects(()=>adapter.generate("BRIEF",campaign,brand),(error:unknown)=>error instanceof Error && !error.message.includes("private") && "code" in error && error.code === "AI_PROVIDER_UNAVAILABLE");
 assert.equal(calls,1);
});


test("enhanced briefs are readable text rather than encoded objects or code blocks", async () => {
 for (const brief of [JSON.stringify({objective:"Visit the studio"}), JSON.stringify(["Visit the studio"]), '```json\n{"objective":"Visit"}\n```']) {
  await assert.rejects(()=>assistant({brief}).generate("BRIEF",campaign,brand), {code:"AI_INVALID_OUTPUT"});
 }
 const draft="Objective\nInvite residents to meet the makers.\n\nMissing details\nConfirm the date.";
 assert.equal((await assistant({brief:draft}).generate("BRIEF",campaign,brand)).brief,draft);
});
