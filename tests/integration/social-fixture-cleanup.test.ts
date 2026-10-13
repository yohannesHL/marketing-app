import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile,writeFile,stat,rm } from "node:fs/promises";
import { dirname } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { socialAllPlatformFixture } from "../support/social-all-platform-fixture";
const run=promisify(execFile);
async function ownedChildren(directory:string){
 const {stdout}=await run("ps",["-axo","pid=,command="]);
 return stdout.split("\n").filter(line=>line.includes(directory)&&line.includes("--data")&&line.includes("--port")).map(line=>{
  const pid=Number(line.trim().split(/\s+/)[0]),port=line.match(/--port\s+(\d+)/)?.[1];assert.ok(port);return {pid,origin:`http://127.0.0.1:${port}`};
 });
}
async function waitForPartialStart(directory:string){
 const deadline=Date.now()+10000;
 while(Date.now()<deadline){
  const children=await ownedChildren(directory);
  if(children.length===5){
   const health=await Promise.all(children.map(async child=>{try{return (await fetch(child.origin+"/health",{signal:AbortSignal.timeout(500)})).status;}catch{return 0;}}));
   if(health.filter(status=>status===200).length===4&&health.filter(status=>status===500).length===1)return children;
  }
  await new Promise(resolve=>setTimeout(resolve,50));
 }
 throw new Error("The real partial-startup HTTP condition was not observed");
}
for(const abort of [false,true])test(abort?"aborted partial initialization reaps every actual Mockoon child and temporary file":"failed X health initialization reaps the four healthy actual Mockoon children and temporary files",{timeout:45000},async()=>{
 const controller=new AbortController();let directory="",prepared!:()=>void;const ready=new Promise<void>(resolve=>{prepared=resolve;});
 const work=socialAllPlatformFixture({signal:controller.signal,configureFixtures:async paths=>{
  directory=dirname(paths.x);const fixture=JSON.parse(await readFile(paths.x,"utf8")),health=fixture.routes.find((route:any)=>route.endpoint==="health");assert.ok(health);
  for(const response of health.responses)response.statusCode=500;await writeFile(paths.x,JSON.stringify(fixture));prepared();
 }}).then(fixture=>({fixture,error:undefined}),(error:unknown)=>({fixture:undefined,error}));
 try{
  await ready;const children=await waitForPartialStart(directory);assert.equal(children.length,5);if(abort)controller.abort();
  const result=await work;assert.equal(result.fixture,undefined);assert.ok(result.error instanceof Error);
  assert.match(result.error.message,abort?/abort/i:/Mockoon fixture failed to start/);
  assert.deepEqual(await ownedChildren(directory),[],"No owned provider child may survive initialization rejection");
  for(const child of children)assert.throws(()=>process.kill(child.pid,0),(error:any)=>error.code==="ESRCH");
  await assert.rejects(stat(directory),(error:any)=>error.code==="ENOENT");
 }finally{
  controller.abort();const result=await work;await result.fixture?.close();
  // Bound a regression failure itself: terminate only children bearing this unique derived-fixture path.
  if(directory){for(const child of await ownedChildren(directory))try{process.kill(child.pid,"SIGTERM");}catch{}await rm(directory,{recursive:true,force:true});}
 }
});
