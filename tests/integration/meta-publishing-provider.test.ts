import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MetaPublishingClient } from '../../apps/web/src/server/providers/metaPublishing';
test('Publishing configuration is separate and never permits an implicit fixture origin', () => {
  const client = new MetaPublishingClient({appId:'123',appSecret:'fixture-app-secret',configId:'789',redirectUri:'https://app.test/api/connections/meta-publishing/callback'});
  assert.equal(new URL(client.authorizationUrl('state')).searchParams.get('config_id'),'789');
  assert.equal(client.pkce,false);
  assert.throws(() => new MetaPublishingClient({appId:'123',appSecret:'fixture-app-secret',configId:'789',redirectUri:'https://app.test/callback',mode:'live',testBaseUrl:'http://127.0.0.1:9999'}));
});
import { after, before } from 'node:test';
import { MetaPublishingError, META_PUBLISHING_SCOPES } from '../../apps/web/src/server/providers/metaPublishing';
import { startMockoon } from '../support/mockoon';
let fixture:Awaited<ReturnType<typeof startMockoon>>;
let client:MetaPublishingClient;
const config={appId:'123',appSecret:'fixture-app-secret',configId:'789',redirectUri:'https://app.test/callback',mode:'mock' as const,now:()=>new Date('2026-10-13T12:00:00Z')};
before(async()=>{fixture=await startMockoon('tests/mockoon/meta-publishing.json');client=new MetaPublishingClient({...config,testBaseUrl:fixture.origin});});
after(async()=>{await fixture?.stop();});
const target=(kind:'FACEBOOK_PAGE'|'INSTAGRAM_PROFILE'='FACEBOOK_PAGE',token='page')=>client.verifyTarget('social',{pageId:'111',accessToken:token},kind,kind==='FACEBOOK_PAGE'?'111':'211');
test('real HTTP USER exchange verifies app, identity, social scopes and actual expiry',async()=>{
 const grant=await client.exchangeCode('success','1001');assert.equal(grant.providerUserId,'1001');assert.equal(grant.accessToken,'social');assert.deepEqual(grant.scopes,META_PUBLISHING_SCOPES);assert.equal(grant.expiresAt?.toISOString(),'2026-10-13T13:00:00.000Z');assert.equal('refreshToken' in grant,false);
 for(const token of ['wrong-app','wrong-type','expired','invalid'])await assert.rejects(client.verifyToken(token),{code:'RECONNECT_REQUIRED'});
 await assert.rejects(client.verifyToken('ads-only'),{code:'MISSING_PERMISSION'});
 await assert.rejects(client.verifyToken('wrong-me'),{code:'SUBJECT_MISMATCH'});
 await assert.rejects(client.verifyToken('social','999'),{code:'SUBJECT_MISMATCH'});
});
test('Page discovery paginates short and empty pages with private credentials separate from DTOs',async()=>{
 const discovered=await client.discoverDestinations('social');assert.deepEqual(discovered.destinations.map(d=>d.externalId),['111','211','112','212']);
 assert.equal(discovered.destinations[2].canPublish,false);assert.equal(discovered.destinations[3].name,'@readonly_ig');assert.deepEqual(discovered.pageCredentials,[{pageId:'111',accessToken:'page'}]);
 assert.equal(JSON.stringify(discovered.destinations).includes('access_token'),false);assert.equal(JSON.stringify(discovered.destinations).includes('unused-private'),false);
 await assert.rejects(client.discoverDestinations('unsafe-next'),{code:'INVALID_PROVIDER_RESPONSE'});
 await assert.rejects(client.discoverDestinations('ads-only'),{code:'MISSING_PERMISSION'});
});
test('Page credential requires current content tasks, verified Page identity and linked IG',async()=>{
 await assert.rejects(client.verifyTarget('role-denied',{pageId:'111',accessToken:'page'},'FACEBOOK_PAGE','111'),{code:'TARGET_UNAVAILABLE'});
 await assert.rejects(target('FACEBOOK_PAGE','page-mismatch'),{code:'TARGET_MISMATCH'});
 await assert.rejects(client.verifyTarget('social',{pageId:'111',accessToken:'page'},'INSTAGRAM_PROFILE','999'),{code:'TARGET_UNAVAILABLE'});
 const proof=await target();assert.equal(JSON.stringify(proof).includes('accessToken'),false);
 await assert.rejects(client.publishFeed({...proof},'forged proof'),{code:'UNVERIFIED_TARGET'});
});
test('Page text and staged image have one final feed request and verified post receipt',async()=>{
 await fetch(`${fixture.origin}/fixture/reset`,{method:'POST'});const proof=await target();
 const photoId=await client.createPhoto(proof,'https://media.test/image.jpg');assert.equal(photoId,'301');
 const postId=await client.publishFeed(proof,'reviewed caption',photoId);assert.equal(postId,'111_401');
 const receipt=await client.publishedStatus(proof,postId);assert.equal(receipt.published,true);assert.match(receipt.publishUrl!,/^https:\/\/www.facebook.com/);
 assert.equal((await (await fetch(`${fixture.origin}/fixture/counts`)).json()).feeds,1);
});
test('Page Reel hosted upload uses its trusted upload boundary and waits for completion',async()=>{
 await fetch(`${fixture.origin}/fixture/reset`,{method:'POST'});const proof=await target();const upload=await client.startReel(proof);
 await assert.rejects(client.uploadReel(proof,upload.videoId,'https://attacker.test/video-upload/v26.0/501','url'),{code:'INVALID_PROVIDER_RESPONSE'});
 await client.uploadReel(proof,upload.videoId,upload.uploadUrl,'https://media.test/api/social/media/video/content?expires=2000000000&signature=fixture');
 assert.equal(await client.reelStatus(proof,'501'),'READY');await client.finishReel(proof,'501','caption','title',false);assert.equal(await client.reelStatus(proof,'501'),'PUBLISHED');
 const counts=await (await fetch(`${fixture.origin}/fixture/counts`)).json();assert.equal(counts.reelStarts,1);assert.equal(counts.reelFinishes,1);assert.equal(counts.uploads,1);
});
test('IG image/Reel container quota and FINISHED gate precede media_publish',async()=>{
 const proof=await target('INSTAGRAM_PROFILE');assert.equal(await client.createContainer(proof,'IMAGE','https://media.test/image.jpg','caption'),'601');
 assert.equal(await client.containerStatus(proof,'601'),'FINISHED');assert.equal(await client.publishContainer(proof,'601'),'701');assert.equal((await client.publishedStatus(proof,'701')).published,true);
 const pending=await target('INSTAGRAM_PROFILE','page-processing');await assert.rejects(client.publishContainer(pending,'601'),{code:'CONTAINER_NOT_READY'});
 const limited=await target('INSTAGRAM_PROFILE','page-quota');await assert.rejects(client.createContainer(limited,'SHORT_VIDEO','https://media.test/video.mp4','caption',true),{code:'RATE_LIMIT'});
 const wrong=await target('INSTAGRAM_PROFILE','page-wrong-owner');await assert.rejects(client.publishedStatus(wrong,'701'),{code:'TARGET_MISMATCH'});
});
test('every HTTP request checks current authorization and errors contain no provider payload',async()=>{
 let calls=0;const guarded=new MetaPublishingClient({...config,testBaseUrl:fixture.origin,beforeRequest:async()=>{if(++calls===2)throw new Error('revoked');}});
 await assert.rejects(guarded.verifyToken('social'),/revoked/);assert.equal(calls,2);
 try{await client.verifyToken('provider-secret');assert.fail();}catch(error){assert.ok(error instanceof MetaPublishingError);assert.equal(String(error).includes('private fixture'),false);assert.equal(JSON.stringify(error).includes('secret payload'),false);}
});
