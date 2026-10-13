import assert from 'node:assert/strict';
import {before,after,test} from 'node:test';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHmac} from 'node:crypto';
import {createClient} from '@libsql/client';
import {PrismaLibSql} from '@prisma/adapter-libsql';
import {PrismaClient} from '../../apps/web/src/generated/prisma/client';
import {CustomerAuth} from '../../apps/web/src/server/auth/customerAuth';
import {CustomerConnections} from '../../apps/web/src/server/connections/customerConnections';
import {ProviderConnectionState} from '../../apps/web/src/server/connections/providerConnectionState';
import {SocialConnectionState} from '../../apps/web/src/server/connections/socialConnectionState';
import {CredentialVault} from '../../apps/web/src/server/security/credentialVault';
import {MetaPageCredentialStore} from '../../apps/web/src/server/connections/metaPageCredentialStore';
import {MetaPublishingConnectionService,createMetaPublishingConnectionApi} from '../../apps/web/src/server/connections/metaPublishingConnectionApi';
import {MetaPublishingClient,META_PUBLISHING_SCOPES} from '../../apps/web/src/server/providers/metaPublishing';
import {MetaLifecycleStore} from '../../apps/web/src/server/connections/metaLifecycleStore';
import {dispatchMetaLifecycle} from '../../apps/web/src/server/connections/metaConnectionApi';
import {applyConnectionMigrations} from '../support/test-database';
import {startMockoon} from '../support/mockoon';
let dir:string,db:PrismaClient,auth:CustomerAuth,connections:CustomerConnections,state:ProviderConnectionState,social:SocialConnectionState,
 vault:CredentialVault,pages:MetaPageCredentialStore,client:MetaPublishingClient,service:MetaPublishingConnectionService,api:ReturnType<typeof createMetaPublishingConnectionApi>,mock:Awaited<ReturnType<typeof startMockoon>>;
const origin='https://app.test',now=()=>new Date('2026-10-13T12:00:00Z');
before(async()=>{mock=await startMockoon('tests/mockoon/meta-publishing.json');dir=await mkdtemp(join(tmpdir(),'meta-publishing-connections-'));const url=`file:${join(dir,'test.sqlite')}`,sql=createClient({url});await applyConnectionMigrations(sql);sql.close();db=new PrismaClient({adapter:new PrismaLibSql({url})});vault=new CredentialVault({test:Buffer.alloc(32,69).toString('base64')},'test');auth=new CustomerAuth(db,{origin},now);connections=new CustomerConnections(db,auth,vault,now);state=new ProviderConnectionState(db,auth,vault,now);social=new SocialConnectionState(db,auth,now);pages=new MetaPageCredentialStore(db,auth,vault,'mock',now);client=new MetaPublishingClient({appId:'123',appSecret:'fixture-app-secret',configId:'789',redirectUri:`${origin}/api/connections/meta-publishing/callback`,mode:'mock',testBaseUrl:mock.origin,now});service=new MetaPublishingConnectionService(auth,connections,state,social,pages,client,'mock',now);api=createMetaPublishingConnectionApi(auth,service);});
after(async()=>{await mock?.stop();await db?.$disconnect();if(dir)await rm(dir,{recursive:true,force:true});});
async function customer(name:string){await auth.provisionCustomer({name,email:`${name}@example.test`,password:'Meta publishing customer test password'});const login=await auth.login(`${name}@example.test`,'Meta publishing customer test password'),cookie=login.cookie.split(';')[0];const principal=await auth.requireSession(new Request(origin,{headers:{cookie}}));const request=(path:string,body:unknown={},method='POST')=>new Request(`${origin}/api/connections/meta-publishing/${path}`,{method,headers:{cookie,Origin:origin,'Content-Type':'application/json'},...(method==='GET'?{}:{body:JSON.stringify(body)})});return{principal,cookie,request};}
async function connected(name:string){const owner=await customer(name),start=await service.start(owner.principal),value=new URL(start.authorizationUrl).searchParams.get('state')!;const result=await service.complete(owner.principal,value,'success');return{owner,result,value};}
test('Meta publishing OAuth is session/Origin bound and persists private Pages before safe SOCIAL DTOs',async()=>{
 const owner=await customer('oauth');assert.equal((await api(new Request(`${origin}/api/connections/meta-publishing/start`,{method:'POST'}))).status,401);
 assert.equal((await api(new Request(`${origin}/api/connections/meta-publishing/start`,{method:'POST',headers:{cookie:owner.cookie,Origin:'https://other.test'}}))).status,403);
 assert.equal((await api(owner.request('start',{accessToken:'forged'}))).status,400);const start=await service.start(owner.principal),query=new URL(start.authorizationUrl);assert.equal(query.searchParams.get('config_id'),'789');assert.equal(query.searchParams.has('code_challenge'),false);
 const response=await api(owner.request(`callback?state=${query.searchParams.get('state')}&code=success`,{},'GET'));assert.equal(response.status,200);const result=await response.json();assert.equal(result.connection.capability,'SOCIAL');assert.deepEqual(result.connection.scopes,[...META_PUBLISHING_SCOPES].sort());assert.equal(result.connection.destinations.length,4);const ig=result.connection.destinations.find((d:{externalId:string})=>d.externalId==='211');assert.equal(ig.metadata.pageId,'111');assert.equal(ig.metadata.canWrite,'ALLOWED');assert.equal(ig.selected,false);
 assert.doesNotMatch(JSON.stringify(result),/accessToken|accessCiphertext|secret|unused-private/);assert.equal(await db.metaPageCredential.count({where:{authorizationId:result.connection.id}}),1);
});
test('callback rejects foreign sessions/replay and declined state is consumed safely',async()=>{
 const a=await customer('state-a'),b=await customer('state-b'),start=await service.start(a.principal),value=new URL(start.authorizationUrl).searchParams.get('state')!;await assert.rejects(service.complete(b.principal,value,'success'),{code:'INVALID_OAUTH_STATE'});await assert.rejects(service.complete(a.principal,value,undefined,true),{code:'CONSENT_DENIED'});await assert.rejects(service.complete(a.principal,value,'success'),{code:'INVALID_OAUTH_STATE'});
 const q=await connected('replay');await assert.rejects(service.complete(q.owner.principal,q.value,'success'),{code:'INVALID_OAUTH_STATE'});
 const deniedStart=await service.start(a.principal),deniedState=new URL(deniedStart.authorizationUrl).searchParams.get('state')!;const html=new Request(`${origin}/api/connections/meta-publishing/callback?state=${deniedState}&error=access_denied&error_description=provider-private-token`,{headers:{cookie:a.cookie,Accept:'text/html'}});const response=await api(html);assert.equal(response.status,303);assert.equal(response.headers.get('location'),`${origin}/connections?provider=meta-publishing&result=failed&error=CONSENT_DENIED`);assert.doesNotMatch(response.headers.get('location')!,/provider-private/);
});
test('duplicate callback loser cannot cancel the winner while exchange is in flight',async()=>{
 const q=await customer('winner'),start=await service.start(q.principal),value=new URL(start.authorizationUrl).searchParams.get('state')!;let release!:()=>void,entered!:()=>void;const wait=new Promise<void>(done=>{release=done;}),ready=new Promise<void>(done=>{entered=done;});const original=client.exchangeCode.bind(client);client.exchangeCode=async(...args)=>{entered();await wait;return original(...args);};
 try{const winner=service.complete(q.principal,value,'success');await ready;await assert.rejects(service.complete(q.principal,value,'success'),{code:'INVALID_OAUTH_STATE'});release();assert.equal((await winner).connection.status,'CONNECTED');}finally{release();client.exchangeCode=original;}
});
test('fresh selection requires owned SOCIAL targets, correct mode, current Page roles and exact version',async()=>{
 const a=await connected('selection-a'),b=await connected('selection-b'),id=a.result.connection.id,ig=a.result.connection.destinations.find(d=>d.externalId==='211')!;
 await assert.rejects(service.refresh(a.owner.principal,id,b.result.connection.destinations[0].id,true),{code:'NOT_FOUND'});const selected=await service.refresh(a.owner.principal,id,ig.id,true);assert.equal(selected.connection.destinations.find(d=>d.id===ig.id)!.selected,true);
 await assert.rejects(social.select(a.owner.principal,id,'META',a.result.connection.credentialVersion+1,ig.id,'mock'),{code:'STALE_CREDENTIALS'});
 const readOnly=a.result.connection.destinations.find(d=>d.externalId==='112')!;await assert.rejects(service.refresh(a.owner.principal,id,readOnly.id,true),{code:'DESTINATION_UNAVAILABLE'});
 const grant=await state.grant(a.owner.principal,id,'META','SOCIAL');await connections.updateCredentials(id,grant.credentialVersion,{accessToken:'role-denied',scopes:[...META_PUBLISHING_SCOPES],expiresAt:new Date('2026-10-15T12:00:00Z')});await assert.rejects(service.refresh(a.owner.principal,id,ig.id,true),{code:'DESTINATION_UNAVAILABLE'});
 assert.equal((await connections.get(a.owner.principal,id)).destinations.find(d=>d.id===ig.id)!.selected,false);assert.equal(await db.metaPageCredential.count({where:{authorizationId:id}}),0);
 const oauth={provider:'META' as const,capability:'ADS' as const,scopes:[...META_PUBLISHING_SCOPES],pkce:false,redirectUri:`${origin}/api/connections/meta/callback`},attempt=await connections.beginOAuth(a.owner.principal,oauth),ads=await connections.completeAuthorization(a.owner.principal,attempt.state,oauth,{providerUserId:'ads-user',accessToken:'social',scopes:[...META_PUBLISHING_SCOPES],connectionMode:'MOCK'});await assert.rejects(service.refresh(a.owner.principal,ads.id),{code:'NOT_FOUND'});
 const live=new MetaPublishingConnectionService(auth,connections,state,social,new MetaPageCredentialStore(db,auth,vault,'live',now),new MetaPublishingClient({appId:'123',appSecret:'fixture-app-secret',configId:'789',redirectUri:service.oauth.redirectUri,mode:'live',now}),'live',now);await assert.rejects(live.refresh(b.owner.principal,b.result.connection.id),{code:'CONNECTION_MODE_MISMATCH'});
});
test('expired or Ads-only grants require reconnect, never fabricated Meta refresh',async()=>{
 for(const scenario of ['expired','ads-only']){const q=await connected(scenario),id=q.result.connection.id;await connections.updateCredentials(id,q.result.connection.credentialVersion,{accessToken:scenario==='ads-only'?'ads-only':'social',scopes:[...META_PUBLISHING_SCOPES],expiresAt:scenario==='expired'?new Date('2026-10-12T00:00:00Z'):new Date('2026-10-15T12:00:00Z')});await assert.rejects(service.refresh(q.owner.principal,id),{code:scenario==='expired'?'RECONNECT_REQUIRED':'MISSING_PERMISSION'});assert.equal((await connections.get(q.owner.principal,id)).status,'RECONNECT_REQUIRED');}
});
test('verified signed Meta callbacks revoke SOCIAL grants and erase Page tokens through existing lifecycle',async()=>{
 const q=await connected('lifecycle'),id=q.result.connection.id,lifecycle=new MetaLifecycleStore(db,{origin,mode:'mock'},now);const signed=(action:string)=>{const payload=Buffer.from(JSON.stringify({algorithm:'HMAC-SHA256',user_id:'1001',issued_at:now().getTime()/1000})).toString('base64url');const value=createHmac('sha256','fixture-app-secret').update(payload).digest('base64url')+'.'+payload;return new Request(`${origin}/api/connections/meta/${action}`,{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({signed_request:value}).toString()});};
 const revoked=await dispatchMetaLifecycle(signed('deauthorize'),{appSecret:'fixture-app-secret',lifecycle});assert.equal(revoked?.status,200);assert.equal((await connections.get(q.owner.principal,id)).status,'REVOKED');const deleted=await dispatchMetaLifecycle(signed('data-deletion'),{appSecret:'fixture-app-secret',lifecycle});assert.equal(deleted?.status,200);assert.equal(await db.metaPageCredential.count({where:{authorizationId:id}}),0);assert.equal(await db.providerAuthorization.count({where:{id}}),0);
});
