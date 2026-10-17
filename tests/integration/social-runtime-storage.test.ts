import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp,rm,stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn,type ChildProcess } from "node:child_process";
import type { Client, Config, Transaction } from "@libsql/client";
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

test("a rejected native COMMIT rolls back once and releases its lock without replaying the Prisma callback", { timeout: 15000 }, async () => {
  const q = await temporaryDatabase();
  const transactions: Transaction[] = [];
  class CaptureForCleanupAdapter extends LocalSqliteAdapter {
    override createClient(config: Config): Client {
      const client = super.createClient(config);
      // Capture only for finally cleanup when this regression is intentionally
      // run against the broken adapter; operations and errors remain unchanged.
      return new Proxy(client, {
        get(target, key) {
          const value = Reflect.get(target, key, target);
          if (key === "transaction") return async (...args: unknown[]) => {
            const transaction: Transaction = await Reflect.apply(value, target, args);
            transactions.push(transaction);
            return transaction;
          };
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
    }
  }
  const adapter = new CaptureForCleanupAdapter({ url: q.url });
  const reader = adapter.createClient({ url: q.url });
  const observer = adapter.createClient({ url: q.url });
  const db = new PrismaClient({ adapter });
  let readerOpen = false;
  try {
    await reader.execute('CREATE TABLE "CommitProbe" ("value" INTEGER)');
    await reader.execute('INSERT INTO "CommitProbe" VALUES (1)');
    // This explicit read transaction is an independent native connection. A
    // DELETE-journal writer can BEGIN/write but cannot COMMIT until it ends.
    await reader.execute("BEGIN DEFERRED");
    readerOpen = true;
    await reader.execute('SELECT * FROM "CommitProbe"');
    let callbacks = 0;
    await assert.rejects(db.$transaction(async tx => {
      callbacks++;
      await tx.$executeRawUnsafe('INSERT INTO "CommitProbe" VALUES (2)');
    }), (error: unknown) => safeCode(error) === "SQLITE_BUSY" &&
      Number((error as { rawCode?: unknown }).rawCode) % 256 === 5);
    assert.equal(callbacks, 1, "A rejected COMMIT must never replay the callback");
    await reader.execute("ROLLBACK");
    readerOpen = false;
    assert.deepEqual((await observer.execute('SELECT "value" FROM "CommitProbe" ORDER BY "value"')).rows.map(row => row.value), [1],
      "The rejected write must be absent and the abandoned writer lock released");
    await db.$transaction(async tx => {
      callbacks++;
      await tx.$executeRawUnsafe('INSERT INTO "CommitProbe" VALUES (3)');
    });
    assert.equal(callbacks, 2, "The independently requested later transaction runs once");
    assert.deepEqual(await db.$queryRawUnsafe('SELECT "value" FROM "CommitProbe" ORDER BY "value"'), [{ value: 1 }, { value: 3 }]);
  } finally {
    if (readerOpen) await reader.execute("ROLLBACK").catch(() => {});
    for (const transaction of transactions) transaction.close();
    reader.close();
    observer.close();
    await db.$disconnect();
    await rm(q.directory, { recursive: true, force: true });
  }
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

test("a transient reader releases during bounded COMMIT backoff without replaying the Prisma callback or write", { timeout: 15000 }, async () => {
  const q = await temporaryDatabase();
  const adapter = new LocalSqliteAdapter({ url: q.url });
  const reader = adapter.createClient({ url: q.url });
  const observer = adapter.createClient({ url: q.url });
  const db = new PrismaClient({ adapter });
  let readerOpen = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let release: Promise<unknown> | undefined;
  let callbacks = 0;
  try {
    await reader.execute('CREATE TABLE "TransientCommitProbe" ("value" INTEGER PRIMARY KEY)');
    await reader.execute('INSERT INTO "TransientCommitProbe" VALUES (1)');
    await reader.execute("BEGIN DEFERRED");
    readerOpen = true;
    await reader.execute('SELECT * FROM "TransientCommitProbe"');
    await db.$transaction(async tx => {
      callbacks++;
      await tx.$executeRawUnsafe('INSERT INTO "TransientCommitProbe" VALUES (2)');
      // Native COMMIT waits synchronously for 100ms. The reader can release
      // only when a bounded retry yields to this same process's timer.
      timer = setTimeout(() => {
        release = reader.execute("ROLLBACK").then(() => { readerOpen = false; });
      }, 25);
    });
    await release;
    assert.equal(readerOpen, false, "The reader's timer must run before COMMIT succeeds");
    assert.equal(callbacks, 1, "Only the failed COMMIT may be retried");
    assert.deepEqual((await observer.execute('SELECT "value" FROM "TransientCommitProbe" ORDER BY "value"')).rows.map(row => row.value), [1, 2],
      "The requested write must appear exactly once");
  } finally {
    if (timer) clearTimeout(timer);
    await release;
    if (readerOpen) await reader.execute("ROLLBACK").catch(() => {});
    reader.close();
    observer.close();
    await db.$disconnect();
    await rm(q.directory, { recursive: true, force: true });
  }
});

test("a real deferred constraint rejection preserves the COMMIT error and cleans up without replaying the callback", { timeout: 15000 }, async () => {
  const q = await temporaryDatabase();
  const transactions: Transaction[] = [];
  let commitCalls = 0;
  let commitError: unknown;
  class ObserveCommitAdapter extends LocalSqliteAdapter {
    override createClient(config: Config): Client {
      const client = super.createClient(config);
      return new Proxy(client, {
        get(target, key) {
          const value = Reflect.get(target, key, target);
          if (key === "transaction") return async (...args: unknown[]) => {
            const transaction: Transaction = await Reflect.apply(value, target, args);
            transactions.push(transaction);
            return new Proxy(transaction, {
              get(tx, method) {
                const fn = Reflect.get(tx, method, tx);
                if (method === "commit") return async () => {
                  commitCalls++;
                  try { await tx.commit(); }
                  catch (error) { commitError = error; throw error; }
                };
                return typeof fn === "function" ? fn.bind(tx) : fn;
              },
            });
          };
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
    }
  }
  const adapter = new ObserveCommitAdapter({ url: q.url });
  const observer = adapter.createClient({ url: q.url });
  const db = new PrismaClient({ adapter });
  try {
    await observer.executeMultiple('CREATE TABLE "CommitParent" ("id" INTEGER PRIMARY KEY);' +
      'CREATE TABLE "CommitChild" ("id" INTEGER PRIMARY KEY, "parentId" INTEGER REFERENCES "CommitParent"("id") DEFERRABLE INITIALLY DEFERRED);' +
      'INSERT INTO "CommitParent" VALUES (1);');
    let callbacks = 0;
    await assert.rejects(db.$transaction(async tx => {
      callbacks++;
      await tx.$executeRawUnsafe('INSERT INTO "CommitChild" VALUES (2, 999)');
    }), (error: unknown) => error === commitError &&
      Number((error as { rawCode?: unknown }).rawCode) % 256 === 19);
    assert.equal(callbacks, 1);
    assert.equal(commitCalls, 1, "Prisma must not replay the rejected transaction's COMMIT");
    assert.deepEqual((await observer.execute('SELECT "id" FROM "CommitChild"')).rows, [],
      "The deferred constraint failure must roll back its pending write");
    await db.$transaction(async tx => {
      callbacks++;
      await tx.$executeRawUnsafe('INSERT INTO "CommitChild" VALUES (3, 1)');
    });
    assert.equal(callbacks, 2);
    assert.equal(commitCalls, 2);
    assert.deepEqual(await db.$queryRawUnsafe('SELECT "id", "parentId" FROM "CommitChild"'), [{ id: 3, parentId: 1 }]);
  } finally {
    for (const transaction of transactions) transaction.close();
    observer.close();
    await db.$disconnect();
    await rm(q.directory, { recursive: true, force: true });
  }
});

test("a failed BEGIN on the same raw client preserves its already detached holder transaction", { timeout: 15000 }, async () => {
  const q = await temporaryDatabase();
  const client = new LocalSqliteAdapter({ url: q.url }).createClient({ url: q.url });
  let holder: Transaction | undefined;
  let unexpected: Transaction | undefined;
  try {
    await client.execute('CREATE TABLE "DetachedHolder" ("value" INTEGER PRIMARY KEY)');
    holder = await client.transaction("deferred");
    await holder.execute('INSERT INTO "DetachedHolder" VALUES (1)');
    await assert.rejects(client.transaction("deferred").then(tx => {
      unexpected = tx;
      return tx;
    }), (error: unknown) => safeCode(error) === "SQLITE_BUSY" &&
      Number((error as { rawCode?: unknown }).rawCode) % 256 === 5);
    assert.equal(holder.closed, false, "Reconnecting an unacquired BEGIN must leave the independent holder active");
    await holder.commit();
    assert.equal(holder.closed, true);
    assert.deepEqual((await client.execute('SELECT "value" FROM "DetachedHolder"')).rows.map(row => row.value), [1],
      "The holder must commit its pending write exactly once");
  } finally {
    unexpected?.close();
    holder?.close();
    client.close();
    await rm(q.directory, { recursive: true, force: true });
  }
});

test("the local client preserves libSQL argument, integer, binary, row and constraint contracts", async () => {
  const q = await temporaryDatabase();
  const create = (intMode: "number" | "bigint" | "string") =>
    new LocalSqliteAdapter({ url: q.url, intMode }).createClient({ url: q.url, intMode });
  const number = create("number"), bigint = create("bigint"), string = create("string");
  try {
    for (const url of ["file:", `${q.url}?ignored=setting`, `${q.url}#ignored`, `file://example.invalid${q.url.slice(5)}`]) {
      assert.throws(() => new LocalSqliteAdapter({ url }).createClient({ url }),
        (error: unknown) => safeCode(error) === "URL_INVALID");
    }
    for (const setting of [{ encryptionKey: "" }, { syncUrl: "https://example.invalid" }, { offline: false }, { readYourWrites: false }]) {
      const config = { url: q.url, ...setting };
      assert.throws(() => new LocalSqliteAdapter(config).createClient(config),
        (error: unknown) => safeCode(error) === "CONFIG_UNSUPPORTED");
    }
    await number.execute('CREATE TABLE "ValueContract" ("id" INTEGER PRIMARY KEY, "large" INTEGER, "payload" BLOB, "name" TEXT UNIQUE)');
    const bytes = new Uint8Array([99, 0, 255, 128, 77]);
    const inserted = await number.execute({
      sql: 'INSERT INTO "ValueContract" ("id", "large", "payload", "name") VALUES (?, ?, ?, ?)',
      args: [1, 9223372036854775807n, bytes.subarray(1, 4), "first"],
    });
    assert.equal(inserted.rowsAffected, 1);
    assert.equal(inserted.lastInsertRowid, 1n);
    // Actual upstream libSQL parity: boolean bindings follow integer mode,
    // including SQLite's storage type rather than only the returned value.
    assert.deepEqual((await number.execute("SELECT typeof(?) AS kind, ? AS flag", [true, true])).rows.map(row => [row.kind, row.flag]), [["real", 1]]);
    assert.deepEqual((await bigint.execute("SELECT typeof(?) AS kind, ? AS flag", [true, true])).rows.map(row => [row.kind, row.flag]), [["integer", 1n]]);
    assert.deepEqual((await string.execute("SELECT typeof(?) AS kind, ? AS flag", [true, true])).rows.map(row => [row.kind, row.flag]), [["text", "1"]]);
    const binary = await number.execute('SELECT "payload" FROM "ValueContract" WHERE "name" = :name', { name: "first" });
    assert.ok(binary.rows[0].payload instanceof ArrayBuffer);
    assert.deepEqual([...new Uint8Array(binary.rows[0].payload as ArrayBuffer)], [0, 255, 128]);
    assert.deepEqual(binary.toJSON().rows, [["AP+A"]]);
    const duplicates = await number.execute("SELECT :left AS duplicate, :right AS duplicate", { left: 7, right: 8 });
    assert.deepEqual(duplicates.columns, ["duplicate", "duplicate"]);
    assert.equal(duplicates.rows[0].length, 2);
    assert.equal(duplicates.rows[0][0], 7);
    assert.equal(duplicates.rows[0][1], 8);
    assert.equal(duplicates.rows[0].duplicate, 7);
    assert.deepEqual(Object.keys(duplicates.rows[0]), ["duplicate"]);
    assert.equal((await bigint.execute('SELECT "large" FROM "ValueContract"')).rows[0].large, 9223372036854775807n);
    assert.equal((await string.execute('SELECT "large" FROM "ValueContract"')).rows[0].large, "9223372036854775807");
    await assert.rejects(number.execute('SELECT "large" FROM "ValueContract"'), RangeError);
    await assert.rejects(number.execute("SELECT ?", [9223372036854775808n]), RangeError);
    await assert.rejects(number.execute("SELECT ?", [Number.POSITIVE_INFINITY]), RangeError);
    await assert.rejects(number.execute('INSERT INTO "ValueContract" ("id", "name") VALUES (2, ?)', ["first"]),
      (error: unknown) => safeCode(error) === "SQLITE_CONSTRAINT" && (error as { rawCode?: unknown }).rawCode === 2067);
    // Failed conversion and constraint checks must not leave a cursor/lock
    // behind. A normal later read and write still use the same client.
    assert.equal((await number.execute('SELECT "id" FROM "ValueContract"')).rows[0].id, 1);
    await number.execute('INSERT INTO "ValueContract" ("id", "name") VALUES (3, ?)', ["later"]);
    assert.deepEqual((await number.execute('SELECT "id" FROM "ValueContract" ORDER BY "id"')).rows.map(row => row.id), [1, 3]);
  } finally {
    number.close();
    bigint.close();
    string.close();
    await rm(q.directory, { recursive: true, force: true });
  }
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
   else{done=await response.json();if(done.status==="COMPLETED"&&done.deliveries.length===7&&done.deliveries.every((delivery:any)=>delivery.status==="SUCCEEDED"))break;}
   await pause(25);
  }
  await activeWork;assert.deepEqual(failures,[],JSON.stringify({failures,reports,workerExit}));assert.equal(workerExit,undefined);assert.equal(activeOAuthSelections,5);assert.ok(ownedPostPolls>1);
  assert.equal(done?.status,"COMPLETED");assert.equal(done.deliveries.length,7);assert.ok(done.deliveries.every((delivery:any)=>delivery.status==="SUCCEEDED"&&delivery.attempts===1));
  assert.deepEqual(await q.counts(),{youtube:{"qa-start":"1","qa-complete":"1"},"meta-publishing":{photos:"1",feeds:"1",containers:"1",igPublishes:"1"},tiktok:{"qa-init":"1"},linkedin:{"qa-image-upload":"1","qa-video-upload":"1","qa-member":"1","qa-organization":"1"},x:{"qa-create":"1","qa-image-upload":"1","qa-unknown-submit":"0"}});
  assert.equal(/x-refresh|x-access|fixture-.*secret|accessToken|refreshToken|Ciphertext/.test(rawOutput),false,"The actual CLI must not print credentials or provider payloads");
  console.info(JSON.stringify({activeOAuthSelections,ownedPostPolls,confirmedDestinations:7,attempts:1,apiErrors:0,workerStopped:false}));
 }finally{await stop(worker);await q.close();}
});
