import assert from 'node:assert/strict';
import {before,after,test} from 'node:test';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createClient} from '@libsql/client';
import {PrismaLibSql} from '@prisma/adapter-libsql';
import {PrismaClient} from '../../apps/web/src/generated/prisma/client';
import {CustomerAuth} from '../../apps/web/src/server/auth/customerAuth';
import {CustomerConnections} from '../../apps/web/src/server/connections/customerConnections';
import {CredentialVault} from '../../apps/web/src/server/security/credentialVault';
import {MetaPageCredentialStore,metaPageCredentialContext,rotateMetaPageCredentialKeys} from '../../apps/web/src/server/connections/metaPageCredentialStore';
import {MetaLifecycleStore} from '../../apps/web/src/server/connections/metaLifecycleStore';
import {META_PUBLISHING_SCOPES} from '../../apps/web/src/server/providers/metaPublishing';
import type {SocialProviderCall} from '../../apps/web/src/server/social/types';
import {applyConnectionMigrations} from '../support/test-database';
let dir:string,db:PrismaClient,auth:CustomerAuth,connections:CustomerConnections,vault:CredentialVault,store:MetaPageCredentialStore;
const origin='https://app.test',now=()=>new Date('2026-10-13T12:00:00Z');
before(async()=>{dir=await mkdtemp(join(tmpdir(),'meta-page-credentials-'));const url=`file:${join(dir,'test.sqlite')}`,sql=createClient({url});await applyConnectionMigrations(sql);sql.close();db=new PrismaClient({adapter:new PrismaLibSql({url})});vault=new CredentialVault({old:Buffer.alloc(32,64).toString('base64')},'old');auth=new CustomerAuth(db,{origin},now);connections=new CustomerConnections(db,auth,vault,now);store=new MetaPageCredentialStore(db,auth,vault,'mock',now);});
after(async()=>{await db?.$disconnect();if(dir)await rm(dir,{recursive:true,force:true});});
async function setup(name:string,capability:'SOCIAL'|'ADS'='SOCIAL',mode:'MOCK'|'LIVE'='MOCK') {
 await auth.provisionCustomer({name,email:`${name}@example.test`,password:'private Page credential test password'});const login=await auth.login(`${name}@example.test`,'private Page credential test password'),principal=await auth.requireSession(new Request(origin,{headers:{cookie:login.cookie.split(';')[0]}}));
 const oauth={provider:'META' as const,capability,pkce:false,scopes:[...META_PUBLISHING_SCOPES],redirectUri:`${origin}/api/connections/meta-publishing/callback`};const start=await connections.beginOAuth(principal,oauth);
 const grant=await connections.completeAuthorization(principal,start.state,oauth,{providerUserId:name==='deletion'?'9999':'1001',externalGrantId:name==='deletion'?'9999':'1001',accessToken:'user-secret',scopes:[...META_PUBLISHING_SCOPES],connectionMode:mode,expiresAt:new Date('2026-10-15T12:00:00Z')});
 const dest=await connections.registerDestination(principal,grant.id,{kind:capability==='SOCIAL'?'FACEBOOK_PAGE':'AD_ACCOUNT',externalId:'111',name:'Private Page fixture'});await db.connectionDestination.update({where:{id:dest.id},data:{selected:true,metadata:{canWrite:'ALLOWED'},lastCheckedAt:now()}});
 const row=await db.providerAuthorization.findUniqueOrThrow({where:{id:grant.id}});
 const call:SocialProviderCall={mode:mode==='MOCK'?'mock':'live',authorizationId:grant.id,providerUserId:row.providerUserId,authorizationGeneration:row.generation,accessToken:'user-secret',verifyCurrent:async()=>{},destination:{kind:'FACEBOOK_PAGE',externalId:'111',metadata:{}},media:[]};
 return{principal,grant,call,oauth,dest};
}
test('Page tokens are encrypted with owner/auth/mode/Page/generation AAD and never public metadata',async()=>{
 const q=await setup('encrypted');await store.persist(q.principal,q.grant.id,q.grant.credentialVersion,[{pageId:'111',accessToken:'page-secret'}]);const row=await db.metaPageCredential.findUniqueOrThrow({where:{authorizationId_pageId:{authorizationId:q.grant.id,pageId:'111'}}});
 assert.doesNotMatch(row.accessCiphertext,/page-secret/);assert.equal(vault.decrypt(row.accessCiphertext,metaPageCredentialContext(row)),'page-secret');assert.equal((await store.resolve(q.call)).accessToken,'page-secret');
 assert.throws(()=>vault.decrypt(row.accessCiphertext,metaPageCredentialContext({...row,pageId:'222'})),{code:'CREDENTIAL_UNAVAILABLE'});
 assert.doesNotMatch(JSON.stringify(await connections.get(q.principal,q.grant.id)),/page-secret|accessCiphertext/);
});
test('install rejects foreign owners, Ads authorization, mode mismatch and stale credential versions',async()=>{
 const a=await setup('owner-a'),b=await setup('owner-b'),ads=await setup('ads','ADS'),live=await setup('live','SOCIAL','LIVE');const tokens=[{pageId:'111',accessToken:'private'}];
 for(const [owner,id,version] of [[b.principal,a.grant.id,a.grant.credentialVersion],[a.principal,a.grant.id,a.grant.credentialVersion+1],[ads.principal,ads.grant.id,ads.grant.credentialVersion],[live.principal,live.grant.id,live.grant.credentialVersion]] as const) await assert.rejects(store.persist(owner,id,version,tokens),{code:'STALE_CREDENTIALS'});
 await assert.rejects(db.metaPageCredential.create({data:{authorizationId:a.grant.id,ownerId:b.principal.userId,pageId:'111',connectionMode:'MOCK',authorizationGeneration:1,credentialVersion:1,accessCiphertext:'forged'}}));
});
test('resolver refuses wrong subject/generation/mode, unselected destination and forged IG Page linkage',async()=>{
 const q=await setup('resolve');await store.persist(q.principal,q.grant.id,q.grant.credentialVersion,[{pageId:'111',accessToken:'page-secret'}]);
 for(const patch of [{providerUserId:'999'},{authorizationGeneration:99},{mode:'live' as const},{authorizationId:undefined}])await assert.rejects(store.resolve({...q.call,...patch}));
 await db.connectionDestination.update({where:{id:q.dest.id},data:{selected:false}});await assert.rejects(store.resolve(q.call),{code:'DESTINATION_UNAVAILABLE'});await db.connectionDestination.update({where:{id:q.dest.id},data:{selected:true}});
 const ig=await connections.registerDestination(q.principal,q.grant.id,{kind:'INSTAGRAM_PROFILE',externalId:'211',name:'IG'});await db.connectionDestination.update({where:{id:ig.id},data:{selected:true,metadata:{pageId:'111',canWrite:'ALLOWED'}}});
 assert.equal((await store.resolve({...q.call,destination:{kind:'INSTAGRAM_PROFILE',externalId:'211',metadata:{pageId:'111'}}})).pageId,'111');await assert.rejects(store.resolve({...q.call,destination:{kind:'INSTAGRAM_PROFILE',externalId:'211',metadata:{pageId:'222'}}}),{code:'DESTINATION_UNAVAILABLE'});
});
test('reconsent generation invalidates old Page credentials while key-only parent version changes do not',async()=>{
 const q=await setup('generation');await store.persist(q.principal,q.grant.id,q.grant.credentialVersion,[{pageId:'111',accessToken:'old-page'}]);
 await db.providerAuthorization.update({where:{id:q.grant.id},data:{credentialVersion:{increment:1}}});assert.equal((await store.resolve(q.call)).accessToken,'old-page');
 const start=await connections.beginOAuth(q.principal,{...q.oauth,reconnectAuthorizationId:q.grant.id});const current=await connections.completeAuthorization(q.principal,start.state,q.oauth,{providerUserId:'1001',externalGrantId:'1001',accessToken:'new-user',scopes:[...META_PUBLISHING_SCOPES],connectionMode:'MOCK',expiresAt:new Date('2026-10-15T12:00:00Z')});
 await db.connectionDestination.update({where:{id:q.dest.id},data:{selected:true}});const row=await db.providerAuthorization.findUniqueOrThrow({where:{id:q.grant.id}});await assert.rejects(store.resolve(q.call),{code:'RECONNECT_REQUIRED'});await assert.rejects(store.resolve({...q.call,authorizationGeneration:row.generation}),{code:'CREDENTIAL_UNAVAILABLE'});
 await store.persist(q.principal,current.id,current.credentialVersion,[{pageId:'111',accessToken:'new-page'}]);assert.equal((await store.resolve({...q.call,authorizationGeneration:row.generation})).accessToken,'new-page');
});
test('rotation reencrypts Page rows with CAS, keeps installs usable and safely counts tampering',async()=>{
 const q=await setup('rotation');await store.persist(q.principal,q.grant.id,q.grant.credentialVersion,[{pageId:'111',accessToken:'rotation-private'}]);const rotated=new CredentialVault({old:Buffer.alloc(32,64).toString('base64'),new:Buffer.alloc(32,65).toString('base64')},'new');
 const counts=await rotateMetaPageCredentialKeys(db,rotated);assert.ok(counts.rotated>0);assert.equal((await new MetaPageCredentialStore(db,auth,rotated,'mock',now).resolve(q.call)).accessToken,'rotation-private');
 const row=await db.metaPageCredential.findUniqueOrThrow({where:{authorizationId_pageId:{authorizationId:q.grant.id,pageId:'111'}}});await db.metaPageCredential.update({where:{authorizationId_pageId:{authorizationId:q.grant.id,pageId:'111'}},data:{accessCiphertext:row.accessCiphertext.slice(0,-1)+'!'}});await assert.rejects(new MetaPageCredentialStore(db,auth,rotated,'mock',now).resolve(q.call),{code:'CREDENTIAL_UNAVAILABLE'});
 const third=new CredentialVault({new:Buffer.alloc(32,65).toString('base64'),third:Buffer.alloc(32,66).toString('base64')},'third');assert.ok((await rotateMetaPageCredentialKeys(db,third)).unavailable>0);
});
test('disconnect and expiry block private resolution, lifecycle deletion cascades Page ciphertext',async()=>{
 const q=await setup('disconnect');await store.persist(q.principal,q.grant.id,q.grant.credentialVersion,[{pageId:'111',accessToken:'disconnect-private'}]);await connections.disconnect(q.principal,q.grant.id);await assert.rejects(store.resolve(q.call),{code:'RECONNECT_REQUIRED'});
 const expired=await setup('expiry');await store.persist(expired.principal,expired.grant.id,expired.grant.credentialVersion,[{pageId:'111',accessToken:'expires-private'}]);await db.metaPageCredential.update({where:{authorizationId_pageId:{authorizationId:expired.grant.id,pageId:'111'}},data:{expiresAt:new Date('2026-10-12T00:00:00Z')}});await assert.rejects(store.resolve(expired.call),{code:'CREDENTIAL_UNAVAILABLE'});
 const deleted=await setup('deletion');await store.persist(deleted.principal,deleted.grant.id,deleted.grant.credentialVersion,[{pageId:'111',accessToken:'delete-private'}]);const lifecycle=new MetaLifecycleStore(db,{origin,mode:'mock'},now);await lifecycle.deleteData('9999',{eventId:'d'.repeat(64)});assert.equal(await db.metaPageCredential.count({where:{authorizationId:deleted.grant.id}}),0);
});
test('rotation CAS never overwrites a Page token installed while rotation was reading',async()=>{
 const q=await setup('rotation-cas');await store.persist(q.principal,q.grant.id,q.grant.credentialVersion,[{pageId:'111',accessToken:'previous'}]);const rotated=new CredentialVault({old:Buffer.alloc(32,64).toString('base64'),next:Buffer.alloc(32,72).toString('base64')},'next');let intercepted=false;
 const injected={metaPageCredential:{findMany:db.metaPageCredential.findMany.bind(db.metaPageCredential),updateMany:async(args:Parameters<typeof db.metaPageCredential.updateMany>[0])=>{
  if(!intercepted && args?.where?.authorizationId===q.grant.id){intercepted=true;await store.persist(q.principal,q.grant.id,q.grant.credentialVersion,[{pageId:'111',accessToken:'concurrent-new'}]);}return db.metaPageCredential.updateMany(args);
 }}} as unknown as PrismaClient;
 const counts=await rotateMetaPageCredentialKeys(injected,rotated);assert.equal(intercepted,true);assert.ok(counts.skipped>0);assert.equal((await store.resolve(q.call)).accessToken,'concurrent-new');
});
test('rotation continues past a concurrently deleted pagination boundary',async()=>{
 const q=await setup('rotation-delete-cursor');await store.persist(q.principal,q.grant.id,q.grant.credentialVersion,Array.from({length:102},(_,i)=>({pageId:String(1000+i),accessToken:`private-${i}`})));
 const rotated=new CredentialVault({old:Buffer.alloc(32,64).toString('base64'),next:Buffer.alloc(32,74).toString('base64')},'next');let deleted=false;
 const injected={metaPageCredential:{findMany:async(args:Parameters<typeof db.metaPageCredential.findMany>[0])=>db.metaPageCredential.findMany({...args,where:{AND:[args?.where??{},{authorizationId:q.grant.id}]}}),
  updateMany:async(args:Parameters<typeof db.metaPageCredential.updateMany>[0])=>{if(!deleted&&args?.where?.pageId==='1099'){deleted=true;await db.metaPageCredential.delete({where:{authorizationId_pageId:{authorizationId:q.grant.id,pageId:'1099'}}});}return db.metaPageCredential.updateMany(args);}}} as unknown as PrismaClient;
 await rotateMetaPageCredentialKeys(injected,rotated);assert.equal(deleted,true);const remaining=await db.metaPageCredential.findMany({where:{authorizationId:q.grant.id}});assert.equal(remaining.filter(row=>row.accessCiphertext.startsWith('enc1.old.')).length,0);
});
