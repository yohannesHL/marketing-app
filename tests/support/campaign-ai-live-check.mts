import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createClient } from '@libsql/client';
import { applyConnectionMigrations } from './test-database.ts';
import { PrismaClient } from '../../apps/web/src/generated/prisma/client.ts';
import { LocalSqliteAdapter } from '../../apps/web/src/server/prisma/localSqliteAdapter.ts';
import { CustomerAuth } from '../../apps/web/src/server/auth/customerAuth.ts';
import { WorkspaceService } from '../../apps/web/src/server/workspace/service.ts';
import { createWorkspaceApi } from '../../apps/web/src/server/workspace/api.ts';
import { assistantSettings } from '../../apps/web/src/server/workspace/assistant.ts';

if (process.env.RUN_LIVE_CAMPAIGN_AI !== '1') throw new Error('Set RUN_LIVE_CAMPAIGN_AI=1 to opt in to real gateway generation.');

const directory = await mkdtemp(join(tmpdir(), 'campaign-ai-live-'));
const url = `file:${join(directory, 'pilot.sqlite')}`;
let db: PrismaClient | undefined;
try {
 assert.deepEqual(assistantSettings(), {mode:'llm-gw',available:true});
 const client = createClient({url}); await applyConnectionMigrations(client); client.close();
 db = new PrismaClient({adapter:new LocalSqliteAdapter({url})});
 const origin = 'https://campaign-ai-pilot.test';
 const auth = new CustomerAuth(db,{origin});
 const user = await auth.provisionCustomer({email:'ai-pilot@example.test',name:'Synthetic AI pilot',password:'SyntheticPilotOnly!2026'});
 const cookie = (await auth.login('ai-pilot@example.test','SyntheticPilotOnly!2026')).cookie.split(';')[0];
 const service = new WorkspaceService(db);
 const api = createWorkspaceApi(auth,service);
 const request = (body:unknown) => new Request(`${origin}/api/workspace/assist`,{method:'POST',headers:{origin,cookie,'content-type':'application/json'},body:JSON.stringify(body)});
 const principal = await auth.requireSession(request({}));
 await service.updateBrand(principal,{version:0,name:'Clayroom Studio',websiteUrl:'https://example.test/clayroom',voice:'Warm, practical and specific. British English.',audience:'Local adults interested in pottery',colors:['#365B43'],rules:'Do not invent prices, discounts, booking availability, certifications or environmental claims.',logoUrl:''});
 const campaign = {type:'SOCIAL',name:'Meet the makers at Clayroom',websiteUrl:'https://example.test/clayroom',brief:'Introduce Clayroom Studio, a ceramics studio. Invite local adults to explore our website and meet the makers through behind-the-scenes pottery content. Show shaping clay on a wheel and glazing. The website has studio information. No event date, price or booking offer is provided. The objective is website visits.',goal:'traffic',audience:'Local adults interested in pottery and handmade objects',platforms:['YOUTUBE','FACEBOOK','INSTAGRAM','TIKTOK','LINKEDIN','X'],plan:{},creatives:[]};
 const results:Record<string,unknown>={testedAt:new Date().toISOString(),provider:'llm-gw',model:process.env.LLM_MODEL,syntheticInput:true};
 for (const action of ['BRIEF','CREATIVES']) {
  const started=Date.now();
  const response=await api(request({action,campaign}));
  const data=await response.json();
  if(response.status!==200) throw new Error(`${action} failed: HTTP ${response.status}, code ${data.code ?? 'unknown'}, ${data.message ?? 'No detail'}`);
  assert.equal(data.mode,'llm-gw');
  if(action==='BRIEF') {assert.ok(data.brief.length>0);campaign.brief=data.brief;results.brief=data.brief;}
  else {assert.deepEqual(data.creatives.map((item:any)=>item.platform),campaign.platforms);results.creatives=data.creatives;}
  results[`${action.toLowerCase()}DurationMs`]=Date.now()-started;
  console.log(JSON.stringify({action,status:response.status,mode:data.mode,durationMs:Date.now()-started,characters:data.brief?.length,platforms:data.creatives?.map((item:any)=>({platform:item.platform,format:item.format,bodyLength:item.body.length,scriptLength:item.script.length}))}));
 }
 const saved=await service.create(principal,{...campaign,creatives:results.creatives,status:'DRAFT'});
 const loaded=await service.get(principal,saved.id);
 assert.deepEqual(loaded.creatives,results.creatives);
 assert.equal(await db.socialPost.count(),0);
 assert.equal(await db.socialDelivery.count(),0);
 const windows=await db.aiRequestWindow.findMany({where:{ownerId:user.id}});
 assert.equal(windows.find(row=>row.key.includes(':day:'))?.count,2);
 results.savedAndReloaded=true;results.socialPosts=0;results.socialDeliveries=0;results.quotaRequests=2;
 await mkdir('docs/evidence/campaign-ai',{recursive:true});
 await writeFile('docs/evidence/campaign-ai/llm-gw-live.json',JSON.stringify(results,null,2)+'\n');
 console.log('PASS: live generation, editable draft round-trip, quota accounting, and no publication.');
} finally {
 await db?.$disconnect(); await rm(directory,{recursive:true,force:true});
}
