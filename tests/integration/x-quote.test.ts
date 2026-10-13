import assert from "node:assert/strict";
import { before, after, test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClient } from "@libsql/client";
import { PrismaLibSql } from "@prisma/adapter-libsql";
import { PrismaClient } from "../../apps/web/src/generated/prisma/client";
import { CustomerAuth } from "../../apps/web/src/server/auth/customerAuth";
import { CustomerConnections } from "../../apps/web/src/server/connections/customerConnections";
import { CredentialVault } from "../../apps/web/src/server/security/credentialVault";
import { SocialMediaStore } from "../../apps/web/src/server/social/mediaStore";
import { quoteXPost, createXQuoteApi } from "../../apps/web/src/server/social/xQuote";
import { X_SCOPES, type XPriceSchedule } from "../../apps/web/src/server/providers/x";
import { xPriceSchedule } from "../../apps/web/src/server/providers/xPricing";
import { applyConnectionMigrations } from "../support/test-database";
const now = new Date("2026-10-13T12:00:00Z"), origin = "http://127.0.0.1:3999";
const prices: XPriceSchedule = { USER_READ: 10000, POST_READ: 5000, POST_CREATE: 15000, POST_CREATE_URL: 200000,
  POST_DELETE: 10000, MEDIA_UPLOAD: 1000, MEDIA_INIT: 1000, MEDIA_APPEND: 1000, MEDIA_FINALIZE: 1000, MEDIA_STATUS: 1000 };
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/a9sAAAAASUVORK5CYII=", "base64");
let directory: string, db: PrismaClient, auth: CustomerAuth, connections: CustomerConnections, store: SocialMediaStore;
before(async () => {
  directory = await mkdtemp(join(tmpdir(), "launchpad-x-quote-")); const url = `file:${join(directory,"test.db")}`;
  const sql = createClient({ url }); await applyConnectionMigrations(sql); sql.close();
  db = new PrismaClient({ adapter: new PrismaLibSql({ url }) }); auth = new CustomerAuth(db, { origin }, () => now);
  const key = Buffer.alloc(32, 88).toString("base64");
  connections = new CustomerConnections(db, auth, new CredentialVault({ test: key }, "test"), () => now);
  store = new SocialMediaStore(db, { directory: join(directory,"media"), origin, signingKey: key, mode: "mock" }, () => now);
});
after(async () => { await db?.$disconnect(); if (directory) await rm(directory,{recursive:true,force:true}); });
async function customer(label: string, capability: "SOCIAL" | "ADS" = "SOCIAL") {
  const email = `${label}@example.test`, password = "isolated quote customer password";
  await auth.provisionCustomer({ email, name: label, password }); const login = await auth.login(email,password), cookie = login.cookie.split(";")[0];
  const principal = await auth.requireSession(new Request(origin,{headers:{cookie}}));
  const oauth = { provider: "X" as const, capability, scopes: [...X_SCOPES], redirectUri: `${origin}/api/connections/x/callback`, pkce: true };
  const attempt = await connections.beginOAuth(principal,oauth);
  // Domain authorization setup only. Local quoting makes no external OAuth or API request.
  const grant = await connections.completeAuthorization(principal,attempt.state,oauth,{ providerUserId: label, accessToken: "quote-private-access", scopes: [...X_SCOPES], connectionMode:"MOCK", expiresAt: new Date(now.getTime()+3600000) });
  const destination = await connections.registerDestination(principal,grant.id,{ kind: capability === "SOCIAL" ? "X_PROFILE" : "AD_ACCOUNT", externalId: label, name: label });
  await db.connectionDestination.update({where:{id:destination.id},data:{selected:true,metadata:{canWrite:"ALLOWED"}}});
  return { principal, destination, cookie };
}
test("local quote uses official weighted text, URL rate and actually inspected owned media without allocating API spend", async () => {
  const owner = await customer("quote-owned"), image = await store.ingest(owner.principal.userId,png,"actual.png");
  const input = { destinationId: owner.destination.id, body: "漢".repeat(140), format: "TEXT", mediaIds: [] };
  const quote = await quoteXPost(db,auth,owner.principal,input,"mock",prices,now);
  assert.equal(quote.weightedLength,280); assert.equal(quote.initialEstimateMicros,50000); assert.equal(quote.withRenewalEstimateMicros,60000);
  const withUrl = await quoteXPost(db,auth,owner.principal,{...input,body:"https://example.com/long/url"},"mock",prices,now);
  assert.equal(withUrl.weightedLength,23); assert.equal(withUrl.includesUrl,true); assert.equal(withUrl.initialEstimateMicros,235000);
  const withImage = await quoteXPost(db,auth,owner.principal,{...input,body:"",format:"IMAGE",mediaIds:[image.id]},"mock",prices,now);
  assert.equal(withImage.initialEstimateMicros,51000); assert.equal(withImage.actualBill,null); assert.equal(withImage.providerCreditBalance,null);
  assert.equal(await db.socialApiCostReservation.count(),0); assert.equal(await db.socialDelivery.count(),0);
  assert.doesNotMatch(JSON.stringify(withImage),/quote-private|storageKey|signature=|Ciphertext/);
});
test("local estimates reject another customer's destination/media, Ads permissions, mode changes and untrusted bytes", async () => {
  const owner = await customer("quote-isolation"), other = await customer("quote-other"), ads = await customer("quote-ads","ADS");
  const image = await store.ingest(other.principal.userId,png,"private.png"), input = {destinationId:owner.destination.id,body:"safe",format:"TEXT",mediaIds:[]};
  await assert.rejects(quoteXPost(db,auth,owner.principal,{...input,destinationId:other.destination.id},"mock",prices,now),{code:"NOT_FOUND"});
  await assert.rejects(quoteXPost(db,auth,owner.principal,{...input,format:"IMAGE",mediaIds:[image.id]},"mock",prices,now),{code:"MEDIA_UNAVAILABLE"});
  await assert.rejects(quoteXPost(db,auth,ads.principal,{...input,destinationId:ads.destination.id},"mock",prices,now),{code:"INVALID_DESTINATION"});
  await assert.rejects(quoteXPost(db,auth,owner.principal,input,"live",prices,now),{code:"CONNECTION_MODE_MISMATCH"});
  await assert.rejects(quoteXPost(db,auth,owner.principal,{...input,body:"漢".repeat(141)},"mock",prices,now),{code:"INVALID_CONTENT"});
  await assert.rejects(quoteXPost(db,auth,owner.principal,{...input,accessToken:"forged"},"mock",prices,now),{code:"INVALID_POST"});
});
test("quote HTTP API enforces real session and Origin and cannot allocate spend or accept caller prices", async () => {
  const owner = await customer("quote-api"), api = createXQuoteApi(db,auth,{mode:"mock",prices,now:()=>now});
  const body = {destinationId:owner.destination.id,body:"local",format:"TEXT",mediaIds:[]};
  const request = (cookie?:string,requestOrigin=origin,value:unknown=body) => new Request(`${origin}/api/social/x/quote`,{method:"POST",headers:{...(cookie?{cookie}:{}),Origin:requestOrigin,"Content-Type":"application/json"},body:JSON.stringify(value)});
  assert.equal((await api(request())).status,401); assert.equal((await api(request(owner.cookie,"https://foreign.test"))).status,403);
  assert.equal((await api(request(owner.cookie,origin,{...body,prices:{USER_READ:0}}))).status,400);
  const good = await api(request(owner.cookie)); assert.equal(good.status,200); assert.equal(good.headers.get("cache-control"),"no-store");
  await auth.logout(owner.principal); assert.equal((await api(request(owner.cookie))).status,401);
});
test("missing or incomplete configured operation rates never invent media billing", () => {
  for (const value of [undefined,"{}","invalid",JSON.stringify({...prices,MEDIA_APPEND:-1}),JSON.stringify({...prices,extra:0})])
    assert.throws(()=>xPriceSchedule({X_API_PRICES:value}),{code:"API_COST_APPROVAL_REQUIRED"});
  assert.deepEqual(xPriceSchedule({X_API_PRICES:JSON.stringify(prices)}),prices);
});
