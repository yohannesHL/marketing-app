import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp,rm,stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn,type ChildProcess } from "node:child_process";
import { setTimeout as pause } from "node:timers/promises";
import { LocalSqliteAdapter } from "../../apps/web/src/server/prisma/localSqliteAdapter";
import { PrismaClient } from "../../apps/web/src/generated/prisma/client";
import { socialAllPlatformFixture,type AllPlatformFixture } from "../support/social-all-platform-fixture";

const providers=["youtube","meta-publishing","tiktok","linkedin","x"] as const;
function safeCode(value:unknown){const code=(value as {code?:unknown}|null)?.code;return typeof code==="string"&&/^[A-Z][A-Z_0-9]{0,63}$/.test(code)?code:"UNCLASSIFIED";}
async function temporaryDatabase(){const directory=await mkdtemp(join(tmpdir(),"runtime-sqlite-"));return {directory,url:"file:"+join(directory,"test.db")};}

test("the actual adapter preserves journal policy and configures finite busy timeout across native connection turnover",async()=>{
 const q=await temporaryDatabase(),db=new PrismaClient({adapter:new LocalSqliteAdapter({url:q.url})});
 try{
  assert.deepEqual(await db.$queryRawUnsafe("PRAGMA journal_mode"),[{journal_mode:"delete"}]);
  assert.deepEqual(await db.$queryRawUnsafe("PRAGMA busy_timeout"),[{timeout:100}]);
  assert.deepEqual(await db.$transaction(tx=>tx.$queryRawUnsafe("PRAGMA busy_timeout")),[{timeout:100}]);
  // Native libSQL detached the previous connection into that transaction; this query opens another.
  assert.deepEqual(await db.$queryRawUnsafe("PRAGMA busy_timeout"),[{timeout:100}]);
  assert.deepEqual(await db.$transaction(tx=>tx.$queryRawUnsafe("PRAGMA journal_mode")),[{journal_mode:"delete"}]);
  assert.deepEqual(await db.$queryRawUnsafe("PRAGMA busy_timeout"),[{timeout:100}]);
  for(const url of [":memory:","file::memory:","file:%3Amemory%3A","file:%3Amemory%3A%3Fcache=shared","file::memory:?cache=shared"]){
   const client=new LocalSqliteAdapter({url}).createClient({url});try{assert.equal((await client.execute("PRAGMA journal_mode")).rows[0].journal_mode,"memory");assert.equal((await client.execute("PRAGMA busy_timeout")).rows[0].timeout,0);}finally{client.close();}
  }
  const path=join(q.directory,":memory:.db"),url="file:"+path,client=new LocalSqliteAdapter({url}).createClient({url});
  try{await client.execute('CREATE TABLE "PersistentMemoryName" ("value" INTEGER)');assert.equal((await client.execute("PRAGMA busy_timeout")).rows[0].timeout,100);assert.equal((await client.execute("PRAGMA journal_mode")).rows[0].journal_mode,"delete");}finally{client.close();}
  assert.ok((await stat(path)).isFile(),"A persistent filename containing :memory: must not be treated as a memory database");
 }finally{await db.$disconnect();await rm(q.directory,{recursive:true,force:true});}
});

test("native BEGIN acquires write intent, rejects bounded contention before any callback, then permits one later write",{timeout:15000},async()=>{
 const q=await temporaryDatabase(),adapter=new LocalSqliteAdapter({url:q.url}),a=adapter.createClient({url:q.url}),b=adapter.createClient({url:q.url});
 let holder:Awaited<ReturnType<typeof a.transaction>>|undefined;
 try{
  await a.execute('CREATE TABLE "BeginProbe" ("value" INTEGER)');await b.execute("PRAGMA busy_timeout");
  holder=await a.transaction("deferred");await holder.execute('INSERT INTO "BeginProbe" VALUES (1)');
  let callbacks=0;const started=performance.now();
  const blocked=b.transaction("deferred").then(async tx=>{callbacks++;try{await tx.execute('INSERT INTO "BeginProbe" VALUES (2)');await tx.commit();}finally{tx.close();}});
  await assert.rejects(blocked,(error:unknown)=>safeCode(error)==="SQLITE_BUSY"&&Number((error as {rawCode?:unknown}).rawCode)%256===5);
  assert.equal(callbacks,0,"No transaction body may run or be replayed when BEGIN cannot acquire a writer");
  assert.ok(performance.now()-started<3000,"Native busy waits and BEGIN backoff must be finite on the same event loop");
  await holder.commit();holder.close();holder=undefined;
  const next=await b.transaction("deferred");try{callbacks++;assert.equal(next.closed,false);await next.execute('INSERT INTO "BeginProbe" VALUES (3)');await next.commit();}finally{next.close();}
  assert.equal(callbacks,1);assert.deepEqual((await b.execute('SELECT COUNT(*) AS n FROM "BeginProbe"')).rows.map(row=>row.n),[2]);
  assert.equal((await b.execute("PRAGMA busy_timeout")).rows[0].timeout,100);
  await b.reconnect();assert.equal((await b.execute("PRAGMA busy_timeout")).rows[0].timeout,100);
 }finally{holder?.close();a.close();b.close();await rm(q.directory,{recursive:true,force:true});}
});

type Owner=Awaited<ReturnType<AllPlatformFixture["customer"]>>;
async function checked(response:Response,status=200){
 if(response.status!==status){const body=await response.json().catch(()=>({}));throw Object.assign(new Error("An owned API rejected the storage stress operation"),{code:safeCode(body),status:response.status});}
 return response.json();
}
async function connect(owner:Owner,name:typeof providers[number]){
 const api=owner.providerApi(name),start=await checked(await api(owner.request(`/api/connections/${name}/start`,name==="x"?{maxApiCostMicros:10000}:{})));
 const state=new URL(start.authorizationUrl).searchParams.get("state")!;
 const result=await checked(await api(owner.request(`/api/connections/${name}/callback?state=${encodeURIComponent(state)}&code=${name==="linkedin"?"organization-code":name==="tiktok"?"private":"success"}`,{},"GET")));
 let connection=result.connection;
 for(const destination of result.connection.destinations.filter((row:any)=>row.available&&row.metadata?.canWrite==="ALLOWED"))
  connection=(await checked(await api(owner.request(`/api/connections/${name}/${result.connection.id}/select`,{destinationId:destination.id})))).connection;
 return connection;
}
async function stop(child:ChildProcess|undefined){
 if(!child||!child.pid||child.exitCode!==null||child.signalCode!==null)return;
 await new Promise<void>(resolve=>{const timer=setTimeout(()=>{child.kill("SIGKILL");},5000);child.once("exit",()=>{clearTimeout(timer);resolve();});child.kill("SIGTERM");});
}

test("real global CLI and owned polling survive five concurrent OAuth selections while all seven reviewed destinations publish once",{timeout:120000},async()=>{
 const q=await socialAllPlatformFixture({origin:"http://127.0.0.1:3989",realClock:true});let worker:ChildProcess|undefined,workerExit:{code:number|null;signal:string|null}|undefined;
 const failures:{operation:string;code:string;status?:number}[]=[],reports:string[]=[];let rawOutput="",activeOAuthSelections=0,ownedPostPolls=0;
 try{
  const owner=await q.customer("runtime-job-owner"),grants=[];
  for(const name of providers)grants.push(await connect(owner,name));
  const destinations=grants.flatMap(grant=>grant.destinations).filter(destination=>destination.selected),image=await owner.upload("png"),video=await owner.upload("video");
  assert.equal(destinations.length,7);
  const variants=destinations.map(destination=>{
   const shared={destinationId:destination.id};
   switch(destination.kind){
    case "YOUTUBE_CHANNEL":return {...shared,format:"SHORT_VIDEO",title:"Adapter private",body:"Synthetic fixture",mediaIds:[video.id],providerOptions:{categoryId:"22",privacyStatus:"private",madeForKids:false,containsSyntheticMedia:true}};
    case "FACEBOOK_PAGE":return {...shared,format:"IMAGE",body:"Reviewed Facebook caption",mediaIds:[image.id],providerOptions:{}};
    case "INSTAGRAM_PROFILE":return {...shared,format:"SHORT_VIDEO",body:"Reviewed Instagram caption",mediaIds:[video.id],providerOptions:{shareToFeed:false}};
    case "TIKTOK_PROFILE":return {...shared,format:"SHORT_VIDEO",body:"fixture-private",mediaIds:[video.id],providerOptions:{privacyLevel:"SELF_ONLY",disableComment:true,disableDuet:true,disableStitch:true,commercialContentDisclosure:false,brandContentToggle:false,brandOrganicToggle:false,musicUsageConsent:true,isAigc:false,explicitPostingConsent:true,creatorInfoVersion:destination.metadata.tiktokCreator.version}};
    case "LINKEDIN_MEMBER":return {...shared,format:"IMAGE",body:"Image fixture",mediaIds:[image.id],providerOptions:{visibility:"PUBLIC"}};
    case "LINKEDIN_ORGANIZATION":return {...shared,format:"SHORT_VIDEO",body:"Organization video fixture",mediaIds:[video.id],providerOptions:{visibility:"PUBLIC"}};
    case "X_PROFILE":return {...shared,format:"IMAGE",body:"Fixture image",mediaIds:[image.id],providerOptions:{madeWithAi:false,paidPartnership:false,maxApiCostMicros:1000000}};
    default:throw new Error("Unexpected verified fixture destination");
   }
  });
  const post=await checked(await owner.api("/api/social/posts",{title:"Active global worker storage",body:"Reviewed source caption",mediaIds:[image.id,video.id],variants}),201);
  await checked(await owner.api(`/api/social/posts/${post.id}/approve`,{revisionId:post.revision.id,destinationIds:destinations.map(destination=>destination.id)}));
  const active=await q.customer("runtime-active-owner");
  worker=spawn(process.execPath,["--import","tsx","apps/web/scripts/social-worker.ts","run"],{env:{...process.env,...q.environment(),CONNECTION_MODE:"mock",ADS_MODE:"mock"},stdio:["ignore","pipe","pipe"]});
  const buffered={stdout:"",stderr:""};
  const inspect=(chunk:Buffer,channel:keyof typeof buffered)=>{
   rawOutput+=String(chunk);const lines=(buffered[channel]+String(chunk)).split("\n");buffered[channel]=lines.pop()!;
   for(const line of lines){try{const value=JSON.parse(line);if(value.status==="STOPPED")failures.push({operation:"worker",code:safeCode(value)});else if(channel==="stdout"&&typeof value.status==="string")reports.push(value.status);}catch{/* Keep unexpected exception text out of diagnostic results. */}}
  };
  worker.stdout!.on("data",chunk=>inspect(chunk,"stdout"));worker.stderr!.on("data",chunk=>inspect(chunk,"stderr"));worker.once("exit",(code,signal)=>{workerExit={code,signal};});worker.once("error",()=>{failures.push({operation:"worker-launch",code:"LAUNCH_FAILED"});});
  await pause(500);
  await checked(await owner.api(`/api/social/posts/${post.id}/enqueue`,{revisionId:post.revision.id,destinationIds:destinations.map(destination=>destination.id),enqueueId:"runtime-seven-once",dueAt:q.now().toISOString(),timeZone:"UTC"}));
  const activeWork=(async()=>{for(const name of providers){try{await connect(active,name);activeOAuthSelections++;}catch(error){failures.push({operation:`active-${name}`,code:safeCode(error),status:(error as {status?:number}).status});}}})();
  let done:any;const deadline=Date.now()+60000;
  while(Date.now()<deadline){
   if(workerExit)break;ownedPostPolls++;
   const response=await owner.api(`/api/social/posts/${post.id}`,{},"GET");
   if(!response.ok){const body=await response.json().catch(()=>({}));failures.push({operation:"owned-post-GET",status:response.status,code:safeCode(body)});}
   else{done=await response.json();if(done.deliveries.length===7&&done.deliveries.every((delivery:any)=>delivery.status==="SUCCEEDED"))break;}
   await pause(25);
  }
  await activeWork;assert.deepEqual(failures,[],JSON.stringify({failures,reports,workerExit}));assert.equal(workerExit,undefined);assert.equal(activeOAuthSelections,5);assert.ok(ownedPostPolls>1);
  assert.equal(done?.status,"COMPLETED");assert.equal(done.deliveries.length,7);assert.ok(done.deliveries.every((delivery:any)=>delivery.status==="SUCCEEDED"&&delivery.attempts===1));
  assert.deepEqual(await q.counts(),{youtube:{"qa-start":"1","qa-complete":"1"},"meta-publishing":{photos:"1",feeds:"1",containers:"1",igPublishes:"1"},tiktok:{"qa-init":"1"},linkedin:{"qa-image-upload":"1","qa-video-upload":"1","qa-member":"1","qa-organization":"1"},x:{"qa-create":"1","qa-image-upload":"1","qa-unknown-submit":"0"}});
  assert.equal(/x-refresh|x-access|fixture-.*secret|accessToken|refreshToken|Ciphertext/.test(rawOutput),false,"The actual CLI must not print credentials or provider payloads");
  console.info(JSON.stringify({activeOAuthSelections,ownedPostPolls,confirmedDestinations:7,attempts:1,apiErrors:0,workerStopped:false}));
 }finally{await stop(worker);await q.close();}
});
