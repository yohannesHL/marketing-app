import assert from "node:assert/strict";
import { mkdtemp,readFile,writeFile,rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import { createClient } from "@libsql/client";
import { LocalSqliteAdapter } from "../../apps/web/src/server/prisma/localSqliteAdapter";
import { PrismaClient } from "../../apps/web/src/generated/prisma/client";
import { CustomerAuth } from "../../apps/web/src/server/auth/customerAuth";
import { CustomerConnections } from "../../apps/web/src/server/connections/customerConnections";
import { ProviderConnectionState } from "../../apps/web/src/server/connections/providerConnectionState";
import { SocialConnectionState } from "../../apps/web/src/server/connections/socialConnectionState";
import { MetaPageCredentialStore } from "../../apps/web/src/server/connections/metaPageCredentialStore";
import { TikTokCreatorState } from "../../apps/web/src/server/connections/tiktokCreatorState";
import { LinkedInConnectionState } from "../../apps/web/src/server/connections/linkedinConnectionState";
import { YouTubeConnectionService,createYouTubeConnectionApi } from "../../apps/web/src/server/connections/youtubeConnectionApi";
import { MetaPublishingConnectionService,createMetaPublishingConnectionApi } from "../../apps/web/src/server/connections/metaPublishingConnectionApi";
import { TikTokConnectionService,createTikTokConnectionApi } from "../../apps/web/src/server/connections/tiktokConnectionApi";
import { LinkedInConnectionService,createLinkedInConnectionApi } from "../../apps/web/src/server/connections/linkedinConnectionApi";
import { XConnectionService,createXConnectionApi } from "../../apps/web/src/server/connections/xConnectionApi";
import { GoogleConnectionService,createGoogleConnectionApi } from "../../apps/web/src/server/connections/googleConnectionApi";
import { MetaConnectionService,createMetaConnectionApi } from "../../apps/web/src/server/connections/metaConnectionApi";
import { GoogleAdsClient } from "../../apps/web/src/server/providers/googleAds";
import { MetaAdsClient } from "../../apps/web/src/server/providers/metaAds";
import { YouTubeClient,YOUTUBE_CHUNK_BYTES } from "../../apps/web/src/server/providers/youtube";
import { MetaPublishingClient } from "../../apps/web/src/server/providers/metaPublishing";
import { LINKEDIN_MEMBER_SCOPES,LINKEDIN_ORGANIZATION_SCOPES } from "../../apps/web/src/server/providers/linkedin";
import { CredentialVault } from "../../apps/web/src/server/security/credentialVault";
import { SocialProviderRegistry } from "../../apps/web/src/server/social/types";
import { youtubeSocialRegistration } from "../../apps/web/src/server/social/providers/youtube";
import { metaPublishingRegistration } from "../../apps/web/src/server/social/providers/metaPublishing";
import { tiktokSocialRegistration } from "../../apps/web/src/server/social/providers/tiktok";
import { linkedinSocialRegistration } from "../../apps/web/src/server/social/providers/linkedin";
import { xSocialRegistration } from "../../apps/web/src/server/social/providers/x";
import { SocialApiBudget,type ApiBudgetOwnerPolicy } from "../../apps/web/src/server/social/apiBudget";
import { SocialMediaStore } from "../../apps/web/src/server/social/mediaStore";
import { createSocialMediaApi } from "../../apps/web/src/server/social/mediaApi";
import { SocialPostService } from "../../apps/web/src/server/social/postService";
import { createSocialPostsApi } from "../../apps/web/src/server/social/postsApi";
import { SocialDeliveryWorker } from "../../apps/web/src/server/social/deliveryWorker";
import { applyConnectionMigrations } from "./test-database";
import { startMockoon } from "./mockoon";
const defaultOrigin="https://launchpad.test", prices={USER_READ:10000,POST_READ:5000,POST_CREATE:15000,POST_CREATE_URL:200000,POST_DELETE:10000,
 MEDIA_UPLOAD:1000,MEDIA_INIT:1000,MEDIA_APPEND:1000,MEDIA_FINALIZE:1000,MEDIA_STATUS:1000};
const platforms=["youtube","meta-publishing","tiktok","linkedin","x"] as const;
let fixtureNumber=0;
type Fixture=any;
const rule=(target:string,modifier:string,value:string,operator="equals")=>({target,modifier,value,operator,invert:false});
const count=(key:string)=>`{{setGlobalVar '${key}' (add (getGlobalVar '${key}' '' 0) 1)}}`;
const ownUrl="^http://127\\.0\\.0\\.1:[0-9]+/api/social/media/[-A-Za-z0-9_]+/content\\?expires=[0-9]{10}&signature=[a-f0-9]{64}$";
function route(f:Fixture,method:string,path:string){const r=f.routes.find((r:any)=>r.method===method&&r.endpoint===path);assert.ok(r,`${method} ${path}`);return r;}
function response(base:any,patch:Record<string,unknown>){return {...structuredClone(base),uuid:randomUUID(),...patch};}
function metrics(f:Fixture,keys:string[]){const base=f.routes[0];f.routes.push({...structuredClone(base),uuid:randomUUID(),method:"get",endpoint:"qa/counts",
 responses:[response(base.responses[0],{statusCode:200,rules:[],body:JSON.stringify(Object.fromEntries(keys.map(k=>[k,`{{getGlobalVar '${k}' '' 0}}`]))),headers:[{key:"Content-Type",value:"application/json"}]})]});}
/** Derived fixtures retain OAuth/identity/role checks and require the generated file's real byte contract. */
async function derivedFixture(name:typeof platforms[number],directory:string,png:Buffer,video:Buffer,origin:string,epoch:number){
 const f=JSON.parse(await readFile(`tests/mockoon/${name}.json`,"utf8")),keys:string[]=[];
 if(name==="youtube"){
  const starts=route(f,"post","upload/youtube/v3/videos"),chunks=route(f,"put","upload/youtube/v3/videos"),reads=route(f,"get","youtube/v3/videos"),replies:any[]=[];
  keys.push("qa-start","qa-complete");
  for(const scenario of ["adapter-private","adapter-pending","adapter-worker-timeout"]){
   for(const p of starts.responses.filter((p:any)=>p.label?.startsWith(scenario)))for(const r of p.rules)if(r.modifier==="x-upload-content-length")r.value=String(video.length);
   const start=starts.responses.find((p:any)=>p.label===scenario+" start");start.body=count("qa-start")+start.body;
   const base=chunks.responses.find((p:any)=>p.label===scenario+" final receipt"),common=base.rules.filter((r:any)=>!["content-range","content-length"].includes(r.modifier));
   for(let offset=0;offset<video.length;offset+=YOUTUBE_CHUNK_BYTES){const end=Math.min(video.length,offset+YOUTUBE_CHUNK_BYTES)-1,final=end===video.length-1;
    replies.push(response(base,{label:`QA ${scenario} actual bytes ${offset}-${end}`,statusCode:final?201:308,rules:[...common,rule("header","content-range",`bytes ${offset}-${end}/${video.length}`),rule("header","content-length",String(end-offset+1))],
     body:final?count("qa-complete")+base.body:"",headers:final?[{key:"Content-Type",value:"application/json"}]:[{key:"Range",value:`bytes=0-${end}`}]}));
   }
   replies.push(response(base,{label:"QA "+scenario+" empty original session probe",statusCode:308,rules:[...common.filter((r:any)=>r.modifier!=="content-type"),rule("header","content-range",`bytes */${video.length}`),rule("header","content-length","0")],body:"",headers:[]}));
   if(scenario!=="adapter-private"){
    const read=reads.responses.find((p:any)=>p.label===scenario+" verified visibility"),complete=JSON.parse(read.body);
    complete.items[0].status.uploadStatus="processed";complete.items[0].processingDetails.processingStatus="succeeded";
    reads.responses.unshift(response(read,{label:"QA confirmed after processing or timeout",latency:0,rules:[...read.rules,rule("global_var","qa-recovery","yes")],body:JSON.stringify(complete)}));
    if(scenario==="adapter-worker-timeout")read.latency=1000;
   }
  }
  chunks.responses.unshift(...replies);
  const base=f.routes[0];f.routes.push({...structuredClone(base),uuid:randomUUID(),method:"post",endpoint:"qa/recover",responses:[response(base.responses[0],{statusCode:200,rules:[],body:"{{setGlobalVar 'qa-recovery' 'yes'}}{}",headers:[{key:"Content-Type",value:"application/json"}]})]});
 }
 if(name==="linkedin"){
  for(const r of f.routes)for(const p of r.responses)for(const match of p.rules??[])if(match.target==="header"&&match.modifier==="authorization"&&match.value==="Bearer member-token")match.value="Bearer org-token";
  for(const p of route(f,"post","rest/images").responses)if(p.label==="Member initialize image")p.rules.find((r:any)=>r.modifier==="authorization").value="Bearer org-token";
  for(const [path,size,kind] of [["dms-uploads/fixtureMember/image",png.length,"image"],["dms-uploads/fixtureOrg/video",video.length,"video"]] as const){
   const p=route(f,"put",path).responses[0];p.rules.find((r:any)=>r.modifier==="content-length").value=String(size);
   if(kind==="image")for(const r of p.rules)if(r.modifier==="authorization")r.value="Bearer org-token";
   p.body=count(`qa-${kind}-upload`)+p.body;keys.push(`qa-${kind}-upload`);
  }
  const init=route(f,"post","rest/videos").responses.find((p:any)=>p.label==="Org initialize video");init.rules.find((r:any)=>r.modifier==="initializeUploadRequest.fileSizeBytes").value=String(video.length);
  init.body=init.body.replace('"lastByte": 79999',`"lastByte": ${video.length-1}`);
  const posts=route(f,"post","rest/posts");
  for(const label of ["Image fixture","Organization video fixture"]){const p=posts.responses.find((p:any)=>p.label===label),key=label==="Image fixture"?"qa-member":"qa-organization";keys.push(key);
   const reject=response(p,{label:"QA reject repeated "+key,statusCode:409,rules:[...p.rules,rule("global_var",key,"1")],body:JSON.stringify({message:"No duplicate publication"}),headers:[{key:"Content-Type",value:"application/json"}]});
   p.body=count(key)+p.body;posts.responses.unshift(reject);
  }
 }
 if(name==="x"){
  for(const p of route(f,"post","2/media/upload").responses)for(const r of p.rules)if(r.modifier==="media")r.value=png.toString("base64");
  const upload=route(f,"post","2/media/upload").responses.find((p:any)=>p.statusCode===200&&p.body.includes('"5001"'));upload.body=count("qa-image-upload")+upload.body;
  const post=route(f,"post","2/tweets").responses.find((p:any)=>p.statusCode===201&&p.body.includes('"6002"'));post.body=count("qa-create")+post.body;keys.push("qa-create","qa-image-upload");
  const unknown=route(f,"post","2/tweets").responses.find((p:any)=>p.rules.some((r:any)=>r.modifier==="text"&&r.value==="Fixture ambiguous"));unknown.body=count("qa-unknown-submit")+unknown.body;keys.push("qa-unknown-submit");
 }
 if(name==="meta-publishing"){
  const photo=route(f,"post","v26.0/111/photos").responses.find((p:any)=>p.rules.some((r:any)=>r.modifier==="authorization"&&r.value==="Bearer page"));photo.rules.push(rule("body","url",ownUrl,"regex"));
  const reel=route(f,"post","v26.0/211/media").responses.find((p:any)=>p.rules.some((r:any)=>r.modifier==="authorization"&&r.value==="Bearer page")&&p.rules.some((r:any)=>r.modifier==="media_type"));reel.rules.push(rule("body","video_url",ownUrl,"regex"),rule("body","share_to_feed","false"));
  keys.push("photos","feeds","containers","igPublishes");
 }
 if(name==="tiktok"){
  const init=route(f,"post","v2/post/publish/video/init/").responses.find((p:any)=>p.label==="fixture-private");init.body=count("qa-init")+init.body;keys.push("qa-init");
 }
 if(name==="tiktok")for(const p of route(f,"get","v2/auth/authorize/").responses)for(const h of p.headers??[])if(h.key.toLowerCase()==="location")h.value=h.value.replace("code=success","code=private");
 const seconds=Math.floor((epoch-Date.parse("2026-10-13T12:00:00Z"))/1000);
 for(const r of f.routes)for(const p of r.responses){
  for(const match of p.rules??[])if(typeof match.value==="string")match.value=match.value.replaceAll(defaultOrigin,origin);
  if(seconds&&typeof p.body==="string")p.body=p.body.replace(/"(expires_at|data_access_expires_at|issued_at|uploadUrlExpiresAt|uploadUrlsExpireAt)"\s*:\s*(\d{10,13})/g,(all:string,key:string,value:string)=>`"${key}": ${Number(value)+seconds*(value.length===13?1000:1)}`);
 }
 metrics(f,keys);
 for(const r of f.routes)for(const p of r.responses)if(typeof p.body==="string"&&p.body.includes("{{"))p.disableTemplating=false;
 const path=join(directory,name+"-actual-media.json");await writeFile(path,JSON.stringify(f));return path;
}
/** Loopback browser bootstraps may share actual database, providers and MediaStore; never export/log this environment in production. */
export async function socialAllPlatformFixture(options:{origin?:string;realClock?:boolean;signal?:AbortSignal;
 /** Mutates isolated derived contracts before their real HTTP servers start; never changes checked-in provider fixtures. */
 configureFixtures?:(paths:Readonly<Record<typeof platforms[number],string>>)=>Promise<void>}={}){
 const origin=options.origin??defaultOrigin;
 if(origin!==defaultOrigin){const parsed=new URL(origin);assert.ok(parsed.protocol==="http:"&&["127.0.0.1","localhost"].includes(parsed.hostname)&&parsed.origin===origin,"Browser fixture origin must be an exact loopback HTTP origin");}
 const checkAbort=()=>options.signal?.throwIfAborted();checkAbort();
 const ownedMocks=new Set<Awaited<ReturnType<typeof startMockoon>>>(),starts:Promise<Awaited<ReturnType<typeof startMockoon>>>[]=[];
 let directory:string|undefined,ownedDb:PrismaClient|undefined,ownedSql:ReturnType<typeof createClient>|undefined,ownedServer:ReturnType<typeof createServer>|undefined,closing:Promise<void>|undefined;
 const close=()=>closing??=(async()=>{
  // A late healthy child must be owned before rollback; starters also stop their own failed children.
  await Promise.allSettled(starts);
  if(ownedServer){ownedServer.closeAllConnections();await new Promise<void>(done=>ownedServer!.close(()=>done()));}
  await Promise.allSettled([...ownedMocks].map(mock=>mock.stop()));
  try{if(ownedDb)await ownedDb.$disconnect();}finally{try{ownedSql?.close();}finally{if(directory)await rm(directory,{recursive:true,force:true});}}
 })();
 function startOwnedMockoon(path:string){
  assert.ok(!closing,"Cannot start providers after fixture cleanup");
  const work=startMockoon(path).then(mock=>{ownedMocks.add(mock);return mock;});starts.push(work);return work;
 }
 try{
 directory=await mkdtemp(join(tmpdir(),"social-all-platforms-"));checkAbort();
 let clock=new Date(Date.parse("2026-10-13T12:00:00Z")+fixtureNumber++*60000),clockOffset=0;const now=()=>options.realClock?new Date(Date.now()+clockOffset):new Date(clock);
 const run=promisify(execFile),imagePath=join(directory,"decoded.png"),videoPath=join(directory,"portrait.mp4");
 await run("ffmpeg",["-v","error","-f","lavfi","-i","color=c=orange:s=720x1280","-frames:v","1","-threads","1","-y",imagePath],{timeout:20000,signal:options.signal});checkAbort();
 await run("ffmpeg",["-v","error","-f","lavfi","-i","testsrc2=s=720x1280:r=30:d=3","-f","lavfi","-i","sine=frequency=440:sample_rate=48000:duration=3",
  "-c:v","libx264","-preset","ultrafast","-crf","28","-pix_fmt","yuv420p","-c:a","aac","-ar","48000","-shortest","-movflags","+faststart","-y",videoPath],{timeout:30000,signal:options.signal});checkAbort();
 const png=await readFile(imagePath),video=await readFile(videoPath);checkAbort();assert.ok(video.length>=75000&&video.length<4194304);
 const generated=await Promise.allSettled(platforms.map(async name=>[name,await derivedFixture(name,directory!,png,video,origin,now().getTime())]));
 const failedWrite=generated.find(result=>result.status==="rejected");if(failedWrite?.status==="rejected")throw failedWrite.reason;checkAbort();
 const fixturePaths=Object.fromEntries(generated.map(result=>(result as PromiseFulfilledResult<[string,string]>).value)) as Record<typeof platforms[number],string>;
 await options.configureFixtures?.(fixturePaths);checkAbort();
 const started=await Promise.allSettled(platforms.map(async name=>[name,await startOwnedMockoon(fixturePaths[name])]));
 checkAbort();const failedStart=started.find(result=>result.status==="rejected");if(failedStart?.status==="rejected")throw failedStart.reason;
 const mocks=Object.fromEntries(started.map(result=>(result as PromiseFulfilledResult<[string,Awaited<ReturnType<typeof startMockoon>>]>).value)) as Record<typeof platforms[number],Awaited<ReturnType<typeof startMockoon>>>;
 const sqlUrl="file:"+join(directory,"test.db"),sql=ownedSql=createClient({url:sqlUrl});
 try{await applyConnectionMigrations(sql);checkAbort();}finally{sql.close();ownedSql=undefined;}
 const db=ownedDb=new PrismaClient({adapter:new LocalSqliteAdapter({url:sqlUrl})}),vault=new CredentialVault({test:Buffer.alloc(32,47).toString("base64")},"test"),auth=new CustomerAuth(db,{origin},now);
 const connections=new CustomerConnections(db,auth,vault,now),state=new ProviderConnectionState(db,auth,vault,now),social=new SocialConnectionState(db,auth,now),pages=new MetaPageCredentialStore(db,auth,vault,"mock",now);
 const adsMocks:Record<string,Awaited<ReturnType<typeof startMockoon>>>={};
 let mediaApi:ReturnType<typeof createSocialMediaApi>;const mediaRequests:{method:string;id:string;bytes:number}[]=[];
 const server=ownedServer=createServer(async(incoming,outgoing)=>{
  try{const url=`http://${incoming.headers.host}${incoming.url}`,id=new URL(url).pathname.match(/^\/api\/social\/media\/([-A-Za-z0-9_]+)\/content$/)?.[1];
   if(!id){outgoing.writeHead(404);outgoing.end();return;}
   const result=await mediaApi(new Request(url,{method:incoming.method,headers:incoming.headers as Record<string,string>}),id),bytes=Buffer.from(await result.arrayBuffer());
   result.headers.forEach((v,k)=>outgoing.setHeader(k,v));outgoing.writeHead(result.status);outgoing.end(bytes);mediaRequests.push({method:incoming.method??"GET",id,bytes:bytes.length});
  }catch{outgoing.writeHead(500);outgoing.end();}
 });
 await new Promise<void>((done,reject)=>{server.once("error",reject);server.listen(0,"127.0.0.1",()=>{server.removeListener("error",reject);done();});});checkAbort();const mediaOrigin=`http://127.0.0.1:${(server.address() as {port:number}).port}`;
 const media=new SocialMediaStore(db,{directory:join(directory,"media"),origin:mediaOrigin,signingKey:Buffer.alloc(32,48).toString("base64"),mode:"mock"},now);mediaApi=createSocialMediaApi(auth,media);
 const ytConfig={clientId:"yt-client",clientSecret:"fixture-yt-secret",redirectUri:origin+"/api/connections/youtube/callback",mockoonEnabled:true,mockoonBaseUrl:mocks.youtube.origin,requestTimeoutMs:500,now};
 const metaConfig={appId:"123",appSecret:"fixture-app-secret",configId:"789",redirectUri:origin+"/api/connections/meta-publishing/callback",mode:"mock" as const,testBaseUrl:mocks["meta-publishing"].origin,now};
 const ttConfig={clientKey:"tt-client",clientSecret:"fixture-tt-secret",redirectUri:origin+"/api/connections/tiktok/callback",mockoonEnabled:true,mockoonBaseUrl:mocks.tiktok.origin,now};
 const liConfig={clientId:"li-client",clientSecret:"fixture-li-secret",redirectUri:origin+"/api/connections/linkedin/callback",scopes:[...new Set([...LINKEDIN_MEMBER_SCOPES,"r_member_social",...LINKEDIN_ORGANIZATION_SCOPES])],version:"202609" as const,mockoonEnabled:true,mockoonBaseUrl:mocks.linkedin.origin,now};
 const xConfig={clientId:"x-client",clientSecret:"fixture-x-secret",redirectUri:origin+"/api/connections/x/callback",mockoonEnabled:true,mockoonBaseUrl:mocks.x.origin,now};
 const registry=new SocialProviderRegistry();registry.register(youtubeSocialRegistration(ytConfig,{mediaOrigin}));
 registry.register(metaPublishingRegistration("FACEBOOK_PAGE",{...metaConfig,mediaOrigin,resolvePageCredential:call=>pages.resolve(call)}));registry.register(metaPublishingRegistration("INSTAGRAM_PROFILE",{...metaConfig,mediaOrigin,resolvePageCredential:call=>pages.resolve(call)}));
 registry.register(tiktokSocialRegistration(ttConfig,{verifiedMediaPrefix:mediaOrigin+"/api/social/media/",audited:false,now}));
 registry.register(linkedinSocialRegistration(liConfig,{mediaOrigin},"LINKEDIN_MEMBER"));registry.register(linkedinSocialRegistration(liConfig,{mediaOrigin},"LINKEDIN_ORGANIZATION"));registry.register(xSocialRegistration(xConfig,{mediaOrigin,prices,now}));
 const config={mode:"mock" as const,writesEnabled:true,approvedProviders:["GOOGLE:YOUTUBE_CHANNEL","META:FACEBOOK_PAGE","META:INSTAGRAM_PROFILE","TIKTOK:TIKTOK_PROFILE","LINKEDIN:LINKEDIN_MEMBER","LINKEDIN:LINKEDIN_ORGANIZATION","X:X_PROFILE"],maxAttempts:5};
 const posts=new SocialPostService(db,auth,config,registry,now),postsApi=createSocialPostsApi(auth,posts),policies:ApiBudgetOwnerPolicy[]=[];
 const ledger=()=>new SocialApiBudget(db,policies,now);
 const apis={youtube:createYouTubeConnectionApi(auth,new YouTubeConnectionService(auth,connections,state,social,new YouTubeClient(ytConfig),"mock",now)),
  "meta-publishing":createMetaPublishingConnectionApi(auth,new MetaPublishingConnectionService(auth,connections,state,social,pages,new MetaPublishingClient(metaConfig),"mock",now)),
  tiktok:createTikTokConnectionApi(auth,new TikTokConnectionService(auth,connections,state,social,new TikTokCreatorState(db,auth,now),ttConfig,"mock",now)),
  linkedin:createLinkedInConnectionApi(auth,new LinkedInConnectionService(auth,connections,state,social,new LinkedInConnectionState(db,auth,now),liConfig,"mock",now))};
 const worker=()=>new SocialDeliveryWorker(db,vault,registry,config,request=>media.resolve(request),now,undefined,ledger());
 async function customer(name:string){
  const password="all platform actual HTTP fixture password";await auth.provisionCustomer({email:name+"@example.test",name,password});const login=await auth.login(name+"@example.test",password),cookie=login.cookie.split(";")[0];
  const principal=await auth.requireSession(new Request(origin,{headers:{cookie}}));policies.push({ownerId:principal.userId,mode:"mock",dailyLimitMicros:2000000,deliveryLimitMicros:1000000,operationCeilings:prices});
  const xApi=createXConnectionApi(auth,new XConnectionService(db,auth,connections,state,social,ledger(),xConfig,"mock",now));
  const request=(path:string,body:unknown={},method="POST")=>new Request(origin+path,{method,headers:{cookie,Origin:origin,"Content-Type":"application/json"},...(method==="GET"?{}:{body:JSON.stringify(body)})});
  const providerApi=(name:typeof platforms[number])=>name==="x"?xApi:apis[name];
  async function connect(name:typeof platforms[number]){
   const api=providerApi(name),start=await api(request(`/api/connections/${name}/start`,name==="x"?{maxApiCostMicros:10000}:{}));assert.equal(start.status,200,await start.clone().text());
   const value=new URL((await start.json()).authorizationUrl).searchParams.get("state")!,callback=await api(request(`/api/connections/${name}/callback?state=${value}&code=${name==="linkedin"?"organization-code":name==="tiktok"?"private":"success"}`,{},"GET"));assert.equal(callback.status,200,await callback.clone().text());
   let result=await callback.json();for(const destination of result.connection.destinations.filter((d:any)=>d.available&&(d.metadata as any)?.canWrite==="ALLOWED")){
    const selected=await api(request(`/api/connections/${name}/${result.connection.id}/select`,{destinationId:destination.id}));assert.equal(selected.status,200,await selected.clone().text());result=await selected.json();
   }return result.connection;
  }
  async function upload(type:"png"|"video"){const form=new FormData();form.append("file",new File([type==="png"?png:video],type==="png"?"decoded.png":"portrait.mp4",{type:"text/plain"}));
   const result=await mediaApi(new Request(origin+"/api/social/media",{method:"POST",headers:{cookie,Origin:origin},body:form}));assert.equal(result.status,201,await result.clone().text());return result.json();}
  async function connectAds(name:"google"|"meta"){
   adsMocks[name]??=await startOwnedMockoon(`tests/mockoon/${name==="google"?"google-ads":"meta-ads"}.json`);
   const api=name==="google"?createGoogleConnectionApi(auth,new GoogleConnectionService(auth,connections,state,new GoogleAdsClient({clientId:"mock-google-client",clientSecret:"mock-client-secret",
    redirectUri:origin+"/api/connections/google/callback",mockoonEnabled:true,mockoonBaseUrl:adsMocks[name].origin},now),"mock",now)):
    createMetaConnectionApi(auth,new MetaConnectionService(auth,connections,state,new MetaAdsClient({appId:"123",appSecret:"fixture-app-secret",configId:"456",redirectUri:origin+"/api/connections/meta/callback",testBaseUrl:adsMocks[name].origin,now}),"mock",now),{appSecret:"fixture-app-secret"});
   const start=await api(request(`/api/connections/${name}/start`));assert.equal(start.status,200,await start.clone().text());const stateValue=new URL((await start.json()).authorizationUrl).searchParams.get("state")!;
   const callback=await api(request(`/api/connections/${name}/callback?state=${stateValue}&code=success`,{},"GET"));assert.equal(callback.status,200,await callback.clone().text());let result=await callback.json();
   const destination=result.connection.destinations.find((d:any)=>d.available&&(name==="google"||d.metadata?.canWrite==="ALLOWED"));assert.ok(destination);
   const selected=await api(request(`/api/connections/${name}/${result.connection.id}/select`,{destinationId:destination.id,...(name==="google"?{loginCustomerId:destination.metadata.contexts[0].loginCustomerId}:{})}));
   assert.equal(selected.status,200,await selected.clone().text());result=await selected.json();return result.connection;
  }
  return {principal,cookie,request,providerApi,connect,connectAds,upload,api:async(path:string,body:unknown={},method="POST")=>postsApi(request(path,body,method))};
 }
 async function counts(){return Object.fromEntries(await Promise.all(platforms.map(async name=>[name,await(await fetch(mocks[name].origin+"/qa/counts")).json()])));}
 const environment=():NodeJS.ProcessEnv=>({APP_ORIGIN:origin,DATABASE_URL:sqlUrl,CONNECTION_MODE:"mock",
  CONNECTION_TOKEN_KEYS:JSON.stringify({test:Buffer.alloc(32,47).toString("base64")}),CONNECTION_ACTIVE_KEY_ID:"test",
  SOCIAL_MEDIA_DIRECTORY:join(directory!,"media"),SOCIAL_MEDIA_PUBLIC_ORIGIN:mediaOrigin,SOCIAL_MEDIA_SIGNING_KEY:Buffer.alloc(32,48).toString("base64"),
  SOCIAL_PUBLISHING_ENABLED:"true",SOCIAL_APPROVED_PROVIDERS:JSON.stringify(config.approvedProviders),
  YOUTUBE_MOCKOON_URL:mocks.youtube.origin,META_PUBLISHING_MOCKOON_URL:mocks["meta-publishing"].origin,META_GRAPH_VERSION:"v26.0",
  TIKTOK_MOCKOON_URL:mocks.tiktok.origin,TIKTOK_VERIFIED_MEDIA_PREFIX:mediaOrigin+"/api/social/media/",TIKTOK_APP_AUDITED:"false",
  LINKEDIN_MOCKOON_URL:mocks.linkedin.origin,LINKEDIN_SCOPES:JSON.stringify(liConfig.scopes),LINKEDIN_MDP_REFRESH_ENABLED:"false",
  X_MOCKOON_URL:mocks.x.origin,X_API_PRICES:JSON.stringify(prices),X_API_OWNER_BUDGETS:JSON.stringify(policies)});
 return {directory,imagePath,videoPath,sqlUrl,fixturePaths,environment,xOwnerPolicies:policies,db,auth,connections,state,vault,media,mediaApi,mediaOrigin,mediaRequests,png,video,mocks,registry,config,posts,postsApi,worker,customer,counts,now,
  advance:(ms:number)=>{if(options.realClock)clockOffset+=ms;else clock=new Date(clock.getTime()+ms);},close};
 }catch(error){await close();throw error;}
}
export type AllPlatformFixture=Awaited<ReturnType<typeof socialAllPlatformFixture>>;
