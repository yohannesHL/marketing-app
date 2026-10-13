import assert from "node:assert/strict";
import { test } from "node:test";
import { spawn,execFile } from "node:child_process";
import { promisify } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import { access,mkdtemp,symlink,stat,rm } from "node:fs/promises";
import { constants } from "node:fs";
import { delimiter,join } from "node:path";
import { tmpdir } from "node:os";
const run=promisify(execFile);
async function processes(){
 const {stdout}=await run("ps",["-axo","pid=,ppid=,command="]);
 return stdout.split("\n").flatMap(line=>{const match=line.match(/^\s*(\d+)\s+(\d+)\s+(.+)$/);return match?[{pid:Number(match[1]),parent:Number(match[2]),command:match[3]}]:[];});
}
async function ffmpegPath(){
 for(const directory of (process.env.PATH??"").split(delimiter)){if(!directory)continue;const path=join(directory,"ffmpeg");try{await access(path,constants.X_OK);return path;}catch{}}
 throw new Error("Actual FFmpeg is required by the launch cleanup regression");
}
test("failed npm launch after real provider startup sanitizes the failure and reaps every owned child",{timeout:45000},async()=>{
 const directory=await mkdtemp(join(tmpdir(),"social-missing-npm-")),bin=join(directory,"ffmpeg"),info=join(directory,"fixture.json");
 await symlink(await ffmpegPath(),bin);let fixtureDirectory="",observed:number[]=[],output="";
 const child=spawn(process.execPath,["--import","tsx","tests/support/start-social-delivery-app.ts"],{
  env:{...process.env,PATH:directory,BASE_URL:"http://127.0.0.1:3198",QA_FIXTURE_INFO:info},stdio:["ignore","pipe","pipe"],
 });
 child.stdout.on("data",chunk=>{output+=String(chunk);});child.stderr.on("data",chunk=>{output+=String(chunk);});
 const exited=new Promise<number|null>(resolve=>child.once("exit",resolve));
 try{
  const deadline=Date.now()+20000;
  while(Date.now()<deadline){
   const providers=(await processes()).filter(value=>value.parent===child.pid&&value.command.includes("--data")&&value.command.includes("social-all-platforms-"));
   if(providers.length===5){const path=providers[0].command.match(/--data\s+(\S+\/social-all-platforms-[^/\s]+)\//)?.[1];assert.ok(path);fixtureDirectory=path;observed=providers.map(value=>value.pid);break;}
   assert.equal(child.exitCode,null,"Setup exited before five actual provider processes were observed");await delay(20);
  }
  assert.equal(observed.length,5);let timer:ReturnType<typeof setTimeout>|undefined;
  try{assert.equal(await Promise.race([exited,new Promise(resolve=>{timer=setTimeout(()=>resolve("timeout"),20000);})]),1,"Failed launch must finish cleanup and return a nonzero exit code");}finally{clearTimeout(timer);}
  assert.deepEqual((await processes()).filter(value=>value.command.includes(fixtureDirectory)),[],"A failed build spawn must not orphan the five ready Mockoons");
  for(const pid of observed)assert.throws(()=>process.kill(pid,0),(error:NodeJS.ErrnoException)=>error.code==="ESRCH");
  await assert.rejects(stat(fixtureDirectory),(error:NodeJS.ErrnoException)=>error.code==="ENOENT");await assert.rejects(stat(info),(error:NodeJS.ErrnoException)=>error.code==="ENOENT");
  assert.match(output,/Isolated mock social-delivery setup stopped/);assert.doesNotMatch(output,/Unhandled|spawn npm|ENOENT|fixture-.*secret|accessToken|refreshToken|Ciphertext/);
 }finally{
  if(child.exitCode===null&&child.signalCode===null){child.kill("SIGKILL");await exited;}
  if(fixtureDirectory){for(const value of (await processes()).filter(value=>value.command.includes(fixtureDirectory)))try{process.kill(value.pid,"SIGTERM");}catch{}await rm(fixtureDirectory,{recursive:true,force:true});}
  await rm(directory,{recursive:true,force:true});
 }
});
