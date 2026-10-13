import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { socialAllPlatformFixture,type AllPlatformFixture } from "../support/social-all-platform-fixture";
async function json(response:Response,status=200){assert.equal(response.status,status,await response.clone().text());return response.json();}
async function connected(q:AllPlatformFixture,name:string){
 const owner=await q.customer(name),grants=[];
 for(const provider of ["youtube","meta-publishing","tiktok","linkedin","x"] as const)grants.push(await owner.connect(provider));
 const destinations=grants.flatMap(g=>g.destinations).filter(d=>d.selected),png=await owner.upload("png"),video=await owner.upload("video");
 assert.equal(destinations.length,7);assert.equal(png.mime,"image/png");assert.equal(video.mime,"video/mp4");assert.equal(video.width,720);assert.equal(video.height,1280);
 assert.equal(video.durationMs,3000);assert.equal(video.metadata.videoCodec,"h264");assert.equal(video.metadata.audioCodec,"aac");assert.equal(video.metadata.audioSampleRate,48000);
 assert.equal(video.metadata.fps,30);assert.equal(video.bytes,q.video.length);assert.equal(png.bytes,q.png.length);
 return {...owner,grants,destinations,png,video};
}
function variants(owner:Awaited<ReturnType<typeof connected>>){return owner.destinations.map(d=>{
 switch(d.kind){
  case "YOUTUBE_CHANNEL":return {destinationId:d.id,format:"SHORT_VIDEO",title:"Adapter private",body:"Synthetic fixture",mediaIds:[owner.video.id],providerOptions:{categoryId:"22",privacyStatus:"private",madeForKids:false,containsSyntheticMedia:true}};
  case "FACEBOOK_PAGE":return {destinationId:d.id,format:"IMAGE",body:"Reviewed Facebook caption",mediaIds:[owner.png.id],providerOptions:{}};
  case "INSTAGRAM_PROFILE":return {destinationId:d.id,format:"SHORT_VIDEO",body:"Reviewed Instagram caption",mediaIds:[owner.video.id],providerOptions:{shareToFeed:false}};
  case "TIKTOK_PROFILE":return {destinationId:d.id,format:"SHORT_VIDEO",body:"fixture-private",mediaIds:[owner.video.id],providerOptions:{privacyLevel:"SELF_ONLY",disableComment:true,disableDuet:true,disableStitch:true,
   commercialContentDisclosure:false,brandContentToggle:false,brandOrganicToggle:false,musicUsageConsent:true,isAigc:false,explicitPostingConsent:true,creatorInfoVersion:d.metadata.tiktokCreator.version}};
  case "LINKEDIN_MEMBER":return {destinationId:d.id,format:"IMAGE",body:"Image fixture",mediaIds:[owner.png.id],providerOptions:{visibility:"PUBLIC"}};
  case "LINKEDIN_ORGANIZATION":return {destinationId:d.id,format:"SHORT_VIDEO",body:"Organization video fixture",mediaIds:[owner.video.id],providerOptions:{visibility:"PUBLIC"}};
  case "X_PROFILE":return {destinationId:d.id,format:"IMAGE",body:"Fixture image",mediaIds:[owner.png.id],providerOptions:{madeWithAi:false,paidPartnership:false,maxApiCostMicros:1000000}};
  default:throw new Error("Unexpected selected destination");
 }
});}
async function reviewed(owner:Awaited<ReturnType<typeof connected>>,chosen=variants(owner)){
 const post=await json(await owner.api("/api/social/posts",{title:"Customer-reviewed mixed post",body:"Reviewed source caption",mediaIds:[owner.png.id,owner.video.id],variants:chosen}),201);
 return json(await owner.api(`/api/social/posts/${post.id}/approve`,{revisionId:post.revision.id,destinationIds:owner.destinations.map(d=>d.id)}));
}
test("all seven actual destination adapters connect, review, schedule and confirm real-media fixture publication without duplicates",{timeout:120000},async()=>{
 const q=await socialAllPlatformFixture();
 try{
  const owner=await connected(q,"all-green"),post=await reviewed(owner),ids=owner.destinations.map(d=>d.id);
  const request={revisionId:post.revision.id,destinationIds:ids,enqueueId:"all-green-idempotent",dueAt:q.now().toISOString(),timeZone:"Europe/London"};
  const queued=await json(await owner.api(`/api/social/posts/${post.id}/enqueue`,request));assert.equal(queued.deliveries.length,7);
  const replay=await json(await owner.api(`/api/social/posts/${post.id}/enqueue`,request));assert.deepEqual(replay.deliveries.map((d:any)=>d.id).sort(),queued.deliveries.map((d:any)=>d.id).sort());
  const outcomes=[];for(let step=0;step<12;step++){const result=await q.worker().runOnce();if(!result)break;outcomes.push(result);}
  const done=await json(await owner.api(`/api/social/posts/${post.id}`,{},"GET"));
  const progress=[];for(const row of await q.db.socialDeliveryProgress.findMany()){const value=JSON.parse(q.vault.decrypt(row.encryptedState,`social-progress-v1:${row.deliveryId}`));progress.push({provider:value.provider,offset:value.offset,totalBytes:value.totalBytes,videoId:value.videoId,sessionSaved:!!value.sessionUrl,media:value.media});}
  assert.deepEqual(done.deliveries.map((d:any)=>({id:d.destinationId,status:d.status,error:d.errorCode})).sort((a:any,b:any)=>a.id.localeCompare(b.id)),
   ids.map(id=>({id,status:"SUCCEEDED",error:null})).sort((a,b)=>a.id.localeCompare(b.id)),JSON.stringify({outcomes,progress,counts:await q.counts()}));
  assert.equal(done.status,"COMPLETED");assert.equal(await q.worker().runOnce(),null);assert.equal(await q.worker().reconcileNext(),null);
  const counts=await q.counts();assert.deepEqual(counts,{youtube:{"qa-start":"1","qa-complete":"1"},"meta-publishing":{photos:"1",feeds:"1",containers:"1",igPublishes:"1"},tiktok:{"qa-init":"1"},
   linkedin:{"qa-image-upload":"1","qa-video-upload":"1","qa-member":"1","qa-organization":"1"},x:{"qa-create":"1","qa-image-upload":"1","qa-unknown-submit":"0"}});
  assert.ok(q.mediaRequests.some(r=>r.method==="GET"&&r.id===owner.video.id&&r.bytes===q.video.length));assert.ok(q.mediaRequests.some(r=>r.method==="HEAD"&&r.id===owner.video.id));
  assert.ok(q.mediaRequests.some(r=>r.method==="GET"&&r.id===owner.png.id&&r.bytes===q.png.length));
  assert.equal(await q.db.campaign.count(),0);assert.equal(await q.db.connectionOperation.count(),0);
  assert.doesNotMatch(JSON.stringify(done),/accessToken|refreshToken|Ciphertext|uploadUrl|signature=|fixture-.*secret|storageKey|digest/);
 }finally{await q.close();}
});
async function drain(q:AllPlatformFixture,limit=12){for(let step=0;step<limit;step++)if(!await q.worker().runOnce())return;throw new Error("Bounded worker drain did not finish");}
test("partial credit failure retries only that reviewed destination and preserves the other six confirmed publications",{timeout:120000},async()=>{
 const q=await socialAllPlatformFixture();try{
  const owner=await connected(q,"partial-credits"),chosen=variants(owner),x=chosen.find(v=>owner.destinations.find(d=>d.id===v.destinationId)?.kind==="X_PROFILE")!;
  Object.assign(x,{format:"TEXT",body:"Fixture credits",mediaIds:[]});const post=await reviewed(owner,chosen);
  const queued=await json(await owner.api(`/api/social/posts/${post.id}/enqueue`,{revisionId:post.revision.id,destinationIds:owner.destinations.map(d=>d.id),enqueueId:"partial-credit-key",dueAt:q.now().toISOString(),timeZone:"UTC"}));
  await drain(q);let done=await json(await owner.api(`/api/social/posts/${post.id}`,{},"GET"));
  const failed=done.deliveries.find((d:any)=>d.destinationId===x.destinationId),success=done.deliveries.filter((d:any)=>d.destinationId!==x.destinationId);
  assert.equal(failed.status,"BLOCKED");assert.equal(failed.errorCode,"PROVIDER_CREDITS_REQUIRED");assert.ok(success.every((d:any)=>d.status==="SUCCEEDED"));assert.equal(success.length,6);
  const before=await q.counts();assert.equal((await owner.api(`/api/social/posts/${post.id}/retry`,{deliveryIds:[success[0].id]})).status,409);
  await json(await owner.api(`/api/social/posts/${post.id}/retry`,{deliveryIds:[failed.id]}));await drain(q);
  done=await json(await owner.api(`/api/social/posts/${post.id}`,{},"GET"));assert.equal(done.deliveries.find((d:any)=>d.id===failed.id).status,"BLOCKED");
  assert.deepEqual(await q.counts(),before);for(const prior of success)assert.deepEqual(done.deliveries.find((d:any)=>d.id===prior.id),prior);
  assert.equal(await q.db.socialDelivery.count({where:{postId:post.id}}),queued.deliveries.length);
  assert.equal(await q.db.socialApiCostReservation.count({where:{deliveryId:failed.id,operation:"POST_CREATE"}}),2);
 }finally{await q.close();}
});
test("a known failed receipt and an unknown create reconcile independently without repeating any successful destination",{timeout:120000},async()=>{
 const q=await socialAllPlatformFixture();try{
  const owner=await connected(q,"partial-uncertain"),chosen=variants(owner);
  const member=chosen.find(v=>owner.destinations.find(d=>d.id===v.destinationId)?.kind==="LINKEDIN_MEMBER")!,x=chosen.find(v=>owner.destinations.find(d=>d.id===v.destinationId)?.kind==="X_PROFILE")!;
  Object.assign(member,{format:"TEXT",body:"worker-failed",mediaIds:[]});Object.assign(x,{format:"TEXT",body:"Fixture ambiguous",mediaIds:[]});
  const post=await reviewed(owner,chosen);await json(await owner.api(`/api/social/posts/${post.id}/enqueue`,{revisionId:post.revision.id,destinationIds:owner.destinations.map(d=>d.id),enqueueId:"partial-unknown-key",dueAt:q.now().toISOString(),timeZone:"UTC"}));
  await drain(q);let done=await json(await owner.api(`/api/social/posts/${post.id}`,{},"GET"));
  const failed=done.deliveries.find((d:any)=>d.destinationId===member.destinationId),unknown=done.deliveries.find((d:any)=>d.destinationId===x.destinationId);
  assert.equal(failed.status,"UNCERTAIN",JSON.stringify(done.deliveries));assert.equal(unknown.status,"UNCERTAIN",JSON.stringify(done.deliveries));assert.equal(done.deliveries.filter((d:any)=>d.status==="SUCCEEDED").length,5);
  const before=await q.counts();assert.equal(before.x["qa-unknown-submit"],"1");q.advance(60000);
  assert.equal((await q.worker().reconcileOnce(failed.id))?.status,"FAILED");assert.equal((await q.worker().reconcileOnce(unknown.id))?.status,"UNCERTAIN");
  done=await json(await owner.api(`/api/social/posts/${post.id}`,{},"GET"));const known=done.deliveries.find((d:any)=>d.id===failed.id);
  assert.equal(known.errorCode,"PROVIDER_PROCESSING_FAILED");assert.ok(known.externalId.startsWith("urn:li:share:"));assert.equal(known.publishUrl,null);
  assert.equal((await owner.api(`/api/social/posts/${post.id}/retry`,{deliveryIds:[failed.id]})).status,409);assert.equal((await owner.api(`/api/social/posts/${post.id}/retry`,{deliveryIds:[unknown.id]})).status,409);
  assert.equal(await q.worker().runOnce(),null);assert.deepEqual(await q.counts(),before);
  assert.deepEqual(await(await fetch(q.mocks.linkedin.origin+"/fixture/posts-count/worker-failed")).json(),{count:1});
 }finally{await q.close();}
});
test("two actual connected customers cannot exchange post/media/grant IDs, and real Ads consent remains separate",{timeout:120000},async()=>{
 const q=await socialAllPlatformFixture();try{
  const alice=await connected(q,"isolation-alice"),bob=await connected(q,"isolation-bob"),post=await reviewed(alice);
  assert.ok(alice.grants.every((g:any)=>bob.grants.every((other:any)=>g.id!==other.id)));
  assert.ok(alice.destinations.every((d:any)=>bob.destinations.every((other:any)=>d.id!==other.id)));
  assert.equal((await bob.api(`/api/social/posts/${post.id}`,{},"GET")).status,404);
  assert.equal((await bob.api(`/api/social/posts/${post.id}/approve`,{revisionId:post.revision.id,destinationIds:alice.destinations.map(d=>d.id)})).status,404);
  assert.equal((await bob.api(`/api/social/posts/${post.id}/enqueue`,{revisionId:post.revision.id,destinationIds:alice.destinations.map(d=>d.id),enqueueId:"foreign-post",dueAt:q.now().toISOString(),timeZone:"UTC"})).status,404);
  assert.equal((await q.mediaApi(bob.request(`/api/social/media/${alice.video.id}`,{},"GET"),alice.video.id)).status,404);
  assert.equal((await q.mediaApi(bob.request(`/api/social/media/${alice.video.id}/content`,{},"GET"),alice.video.id)).status,404);
  const forged=await bob.api("/api/social/posts",{title:"Foreign media",body:"Caption",mediaIds:[alice.video.id],variants:[]});assert.ok(forged.status>=400&&forged.status<500);
  for(const provider of ["youtube","meta-publishing","tiktok","linkedin","x"] as const){
   const grant=alice.grants.find((g:any)=>g.provider==={youtube:"GOOGLE","meta-publishing":"META",tiktok:"TIKTOK",linkedin:"LINKEDIN",x:"X"}[provider]);
   const foreign=await bob.providerApi(provider)(bob.request(`/api/connections/${provider}/${grant.id}/select`,{destinationId:grant.destinations.find((d:any)=>d.selected).id}));assert.equal(foreign.status,404);
   const start=await alice.providerApi(provider)(alice.request(`/api/connections/${provider}/start`,provider==="x"?{maxApiCostMicros:10000}:{}));const state=new URL((await json(start)).authorizationUrl).searchParams.get("state")!;
   const stolen=await bob.providerApi(provider)(bob.request(`/api/connections/${provider}/callback?state=${state}&code=success`,{},"GET"));assert.equal(stolen.status,400);
  }
  const ads=[await alice.connectAds("google"),await alice.connectAds("meta")];assert.ok(ads.every((g:any)=>g.capability==="ADS"&&g.destinations.every((d:any)=>d.kind==="AD_ACCOUNT")));
  for(const grant of ads){const target=grant.destinations.find((d:any)=>d.selected);assert.ok(target);
   const result=await alice.api("/api/social/posts",{title:"Ads cannot publish",body:"Caption",mediaIds:[],variants:[{destinationId:target.id,format:"TEXT"}]});assert.ok(result.status>=400&&result.status<500);
  }
  assert.equal((await alice.api("/api/social/posts",{title:"Wrong category",body:"Caption",mediaIds:[],variants:[],budget:100,audience:{country:"GB"}})).status,400);
  assert.equal(await q.db.campaign.count(),0);assert.equal(await q.db.connectionOperation.count(),0);
  const mine=await q.connections.list(alice.principal),theirs=await q.connections.list(bob.principal);assert.ok(mine.every(c=>!theirs.some(other=>other.id===c.id)));
  assert.equal(await q.db.metaPageCredential.count({where:{ownerId:alice.principal.userId}}),1);assert.equal(await q.db.metaPageCredential.count({where:{ownerId:bob.principal.userId}}),1);
 }finally{await q.close();}
});
test("explicit UTC instants distinguish DST overlap; reschedule, cancel and revision edits prevent every unsent platform publication",{timeout:120000},async()=>{
 const q=await socialAllPlatformFixture();try{
  const owner=await connected(q,"schedule-controls"),chosen=variants(owner),member=chosen.find(v=>owner.destinations.find(d=>d.id===v.destinationId)?.kind==="LINKEDIN_MEMBER")!;
  const dstPost=await json(await owner.api("/api/social/posts",{title:"DST overlap",body:"Reviewed caption",mediaIds:[owner.png.id],variants:[member]}),201);
  await json(await owner.api(`/api/social/posts/${dstPost.id}/approve`,{revisionId:dstPost.revision.id,destinationIds:[member.destinationId]}));
  const first="2026-10-25T00:30:00Z",second="2026-10-25T01:30:00Z";
  const scheduled=await json(await owner.api(`/api/social/posts/${dstPost.id}/enqueue`,{revisionId:dstPost.revision.id,destinationIds:[member.destinationId],enqueueId:"dst-earlier",dueAt:first,timeZone:"Europe/London"}));
  assert.equal(scheduled.deliveries[0].dueAt,"2026-10-25T00:30:00.000Z");assert.equal(scheduled.deliveries[0].timeZone,"Europe/London");
  const moved=await json(await owner.api(`/api/social/posts/${dstPost.id}/reschedule`,{deliveryIds:[scheduled.deliveries[0].id],dueAt:second,timeZone:"Europe/London"}));assert.equal(moved.deliveries[0].dueAt,"2026-10-25T01:30:00.000Z");
  assert.equal((await owner.api(`/api/social/posts/${dstPost.id}/reschedule`,{deliveryIds:[scheduled.deliveries[0].id],dueAt:"2026-10-25T01:30:00",timeZone:"Europe/London"})).status,400);
  await json(await owner.api(`/api/social/posts/${dstPost.id}/cancel`,{deliveryIds:[scheduled.deliveries[0].id]}));
  const post=await reviewed(owner),later=new Date(q.now().getTime()+120000).toISOString(),ids=owner.destinations.map(d=>d.id);
  const queued=await json(await owner.api(`/api/social/posts/${post.id}/enqueue`,{revisionId:post.revision.id,destinationIds:ids,enqueueId:"cancel-all",dueAt:later,timeZone:"UTC"}));assert.equal(await q.worker().runOnce(),null);
  await json(await owner.api(`/api/social/posts/${post.id}/reschedule`,{deliveryIds:queued.deliveries.map((d:any)=>d.id),dueAt:new Date(q.now().getTime()+180000).toISOString(),timeZone:"America/New_York"}));
  const cancelled=await json(await owner.api(`/api/social/posts/${post.id}/cancel`,{deliveryIds:queued.deliveries.map((d:any)=>d.id)}));assert.ok(cancelled.deliveries.every((d:any)=>d.status==="CANCELLED"));
  const next=await reviewed(owner),queuedNext=await json(await owner.api(`/api/social/posts/${next.id}/enqueue`,{revisionId:next.revision.id,destinationIds:ids,enqueueId:"edit-all",dueAt:later,timeZone:"UTC"}));
  const edited=await json(await owner.api(`/api/social/posts/${next.id}`,{revisionId:next.revision.id,title:"Changed content",body:"New caption",mediaIds:[owner.png.id,owner.video.id],variants:chosen},"PATCH"));
  assert.equal(edited.revision.reviewedAt,null);assert.ok(edited.deliveries.every((d:any)=>d.status==="SUPERSEDED"));assert.equal(edited.deliveries.length,queuedNext.deliveries.length);
  q.advance(240000);assert.equal(await q.worker().runOnce(),null);const counts=await q.counts();for(const values of Object.values(counts))assert.ok(Object.values(values as any).every(value=>value==="0"));
  assert.equal(await q.db.campaign.count(),0);assert.equal(await q.db.connectionOperation.count(),0);
 }finally{await q.close();}
});
test("accepted pending and timed-out status reads reconcile saved receipts without uploading or publishing again",{timeout:120000},async()=>{
 const q=await socialAllPlatformFixture();try{
  const owner=await q.customer("accepted-recovery"),grant=await owner.connect("youtube"),destination=grant.destinations.find((d:any)=>d.selected)!,media=await owner.upload("video"),saved=[];
  for(const title of ["Adapter pending","Adapter worker-timeout"]){
   let post=await json(await owner.api("/api/social/posts",{title,body:"Synthetic fixture",mediaIds:[media.id],variants:[{destinationId:destination.id,format:"SHORT_VIDEO",title,body:"Synthetic fixture",mediaIds:[media.id],
    providerOptions:{categoryId:"22",privacyStatus:"private",madeForKids:false,containsSyntheticMedia:true}}]}),201);
   post=await json(await owner.api(`/api/social/posts/${post.id}/approve`,{revisionId:post.revision.id,destinationIds:[destination.id]}));
   await json(await owner.api(`/api/social/posts/${post.id}/enqueue`,{revisionId:post.revision.id,destinationIds:[destination.id],enqueueId:title.toLowerCase().replaceAll(" ","-"),dueAt:q.now().toISOString(),timeZone:"UTC"}));
   await drain(q);post=await json(await owner.api(`/api/social/posts/${post.id}`,{},"GET"));const delivery=post.deliveries[0];
   assert.equal(delivery.status,"UNCERTAIN",JSON.stringify(delivery));assert.equal(delivery.externalId,null);
   const checkpoint=await q.db.socialDeliveryProgress.findUniqueOrThrow({where:{deliveryId:delivery.id}}),receipt=JSON.parse(q.vault.decrypt(checkpoint.encryptedState,`social-progress-v1:${delivery.id}`));assert.match(receipt.videoId,/^adapterVideo(Pending|WorkerTimeout)$/);
   assert.equal((await owner.api(`/api/social/posts/${post.id}/retry`,{deliveryIds:[delivery.id]})).status,409);
   saved.push({postId:post.id,deliveryId:delivery.id,externalId:receipt.videoId});
  }
  const before=await q.counts();assert.deepEqual(before.youtube,{"qa-start":"2","qa-complete":"2"});
  q.advance(60000);await q.worker().reconcileNext();await q.worker().reconcileNext();
  for(const item of saved){const post=await json(await owner.api(`/api/social/posts/${item.postId}`,{},"GET"));assert.equal(post.deliveries[0].status,"UNCERTAIN");}
  assert.equal((await fetch(q.mocks.youtube.origin+"/qa/recover",{method:"POST"})).status,200);q.advance(120000);
  await q.worker().reconcileNext();await q.worker().reconcileNext();
  for(const item of saved){const post=await json(await owner.api(`/api/social/posts/${item.postId}`,{},"GET"));assert.equal(post.deliveries[0].status,"SUCCEEDED");assert.equal(post.deliveries[0].externalId,item.externalId);assert.equal(post.status,"COMPLETED");}
  assert.equal(await q.worker().runOnce(),null);assert.deepEqual(await q.counts(),before);assert.equal(await q.db.socialDelivery.count(),2);
 }finally{await q.close();}
});
test("real-clock loopback bootstrap exports configured runtime and completes actual provider HTTP browser consent redirects",{timeout:120000},async()=>{
 const origin="http://127.0.0.1:4399",q=await socialAllPlatformFixture({origin,realClock:true});try{
  const owner=await q.customer("loopback-browser"),environment=q.environment();assert.equal(environment.APP_ORIGIN,origin);assert.equal(environment.DATABASE_URL,q.sqlUrl);
  assert.equal(environment.SOCIAL_MEDIA_PUBLIC_ORIGIN,q.mediaOrigin);assert.equal(environment.CONNECTION_MODE,"mock");assert.equal(JSON.parse(environment.X_API_OWNER_BUDGETS!)[0].ownerId,owner.principal.userId);
  assert.ok(Math.abs(q.now().getTime()-Date.now())<1000);assert.equal((await readFile(q.imagePath)).length,q.png.length);assert.equal((await readFile(q.videoPath)).length,q.video.length);
  for(const name of ["youtube","meta-publishing","tiktok","linkedin","x"] as const){
   const api=owner.providerApi(name),start=await json(await api(owner.request(`/api/connections/${name}/start`,name==="x"?{maxApiCostMicros:10000}:{})));
   const consent=await fetch(start.authorizationUrl,{redirect:"manual"});assert.equal(consent.status,302,name);
   const callback=new URL(consent.headers.get("location")!);assert.equal(callback.origin,origin);assert.equal(callback.pathname,`/api/connections/${name}/callback`);
   const result=await api(new Request(callback,{headers:{cookie:owner.cookie,accept:"text/html"}}));assert.equal(result.status,303,name+" "+result.headers.get("location"));
   const returned=new URL(result.headers.get("location")!);assert.equal(returned.origin,origin);assert.equal(returned.pathname,"/connections");assert.equal(returned.searchParams.get("result"),"connected");
  }
  const grants=await q.connections.list(owner.principal);assert.equal(grants.length,5);assert.equal(grants.flatMap((g:any)=>g.destinations).filter((d:any)=>d.available&&d.metadata?.canWrite==="ALLOWED").length,7);assert.equal(grants.flatMap((g:any)=>g.destinations).filter((d:any)=>d.selected).length,0);
 }finally{await q.close();}
});
