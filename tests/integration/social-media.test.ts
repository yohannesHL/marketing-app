import assert from "node:assert/strict";
import { before, after, test } from "node:test";
import { mkdtemp, readFile, rm, chmod, writeFile, readdir, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createClient } from "@libsql/client";
import { PrismaLibSql } from "@prisma/adapter-libsql";
import { PrismaClient } from "../../apps/web/src/generated/prisma/client";
import { CustomerAuth } from "../../apps/web/src/server/auth/customerAuth";
import { SocialMediaStore } from "../../apps/web/src/server/social/mediaStore";
import { createSocialMediaApi } from "../../apps/web/src/server/social/mediaApi";
import { applyConnectionMigrations } from "../support/test-database";

const origin = "http://127.0.0.1:3999";
const key = Buffer.alloc(32, 41).toString("base64");
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/a9sAAAAASUVORK5CYII=", "base64");
let directory: string, db: PrismaClient, auth: CustomerAuth, store: SocialMediaStore;
let clock = new Date("2026-10-13T12:00:00Z");

before(async () => {
  directory = await mkdtemp(join(tmpdir(), "launchpad-media-"));
  const url = `file:${join(directory, "test.db")}`;
  const sql = createClient({ url }); await applyConnectionMigrations(sql); sql.close();
  db = new PrismaClient({ adapter: new PrismaLibSql({ url }) });
  auth = new CustomerAuth(db, { origin }, () => clock);
  store = new SocialMediaStore(db, { directory: join(directory, "media"), origin, signingKey: key, mode: "mock" }, () => clock);
});
after(async () => { await db?.$disconnect(); if (directory) await rm(directory, { recursive: true, force: true }); });

async function customer(label: string) {
  const email = `${label}@example.test`, password = "isolated media customer password";
  const user = await auth.provisionCustomer({ email, name: label, password });
  const login = await auth.login(email, password);
  return { id: user.id, cookie: login.cookie.split(";")[0] };
}

test("actual bytes and ffprobe determine metadata; paths, hashes and signing keys stay private", async () => {
  const owner = await customer("media-inspect");
  const asset = await store.ingest(owner.id, png, "../../portrait.png");
  assert.equal(asset.type, "IMAGE"); assert.equal(asset.mime, "image/png");
  assert.equal(asset.width, 1); assert.equal(asset.height, 1); assert.equal(asset.filename, "portrait.png");
  assert.equal(asset.status, "AVAILABLE");
  assert.equal("storageKey" in asset, false); assert.equal("digest" in asset, false);
  assert.equal(JSON.stringify(asset).includes(key), false);
  const response = await store.content(asset.id, new Request(`${origin}/api/social/media/${asset.id}/content`), owner.id);
  assert.equal(response.headers.get("content-type"), "image/png");
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), png);
});

test("real MP4 probing records duration, codec and display dimensions instead of filename claims", async () => {
  const owner = await customer("media-video");
  const filename = join(directory, "actual.mp4");
  await promisify(execFile)("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "color=c=blue:s=320x480:r=30:d=1",
    "-c:v", "libx264", "-pix_fmt", "yuv420p", "-an", "-y", filename], { timeout: 20_000 });
  const asset = await store.ingest(owner.id, await readFile(filename), "pretend-image.jpeg");
  assert.equal(asset.mime, "video/mp4"); assert.equal(asset.type, "VIDEO");
  assert.equal(asset.width, 320); assert.equal(asset.height, 480); assert.equal(asset.durationMs, 1000);
  assert.equal((asset.metadata as { fps: number }).fps, 30);
});

test("authenticated upload rejects unauthenticated, cross-origin and forged browser metadata", async () => {
  const owner = await customer("media-http"); const api = createSocialMediaApi(auth, store);
  const form = () => { const value = new FormData(); value.append("file", new File([png], "actual.png", { type: "text/html" })); return value; };
  assert.equal((await api(new Request(`${origin}/api/social/media`, { method: "POST", body: form() }))).status, 401);
  assert.equal((await api(new Request(`${origin}/api/social/media`, { method: "POST", headers: { cookie: owner.cookie, Origin: "https://other.test" }, body: form() }))).status, 403);
  const forged = form(); forged.append("width", "1080"); forged.append("url", "http://169.254.169.254/");
  assert.equal((await api(new Request(`${origin}/api/social/media`, { method: "POST", headers: { cookie: owner.cookie, Origin: origin }, body: forged }))).status, 400);
  const valid = await api(new Request(`${origin}/api/social/media`, { method: "POST", headers: { cookie: owner.cookie, Origin: origin }, body: form() }));
  assert.equal(valid.status, 201); const asset = await valid.json();
  assert.equal(asset.mime, "image/png"); assert.equal(asset.width, 1);
  const other = await customer("media-other");
  assert.equal((await api(new Request(`${origin}/api/social/media/${asset.id}`, { headers: { cookie: other.cookie } }), asset.id)).status, 404);
  assert.equal((await api(new Request(`${origin}/api/social/media/${asset.id}/content`, { headers: { cookie: other.cookie } }), asset.id)).status, 404);
});

test("signed media links are exact, expiring and range-aware; another customer cannot mint them", async () => {
  const owner = await customer("media-signed"), other = await customer("media-signed-other");
  const created = await store.ingest(owner.id, png); const asset = await store.owned(owner.id, created.id);
  const [link] = await store.resolve({ ownerId: owner.id, media: [asset], minimumValidUntil: new Date(clock.getTime() + 3600_000) });
  const api = createSocialMediaApi(auth, store);
  const partial = await api(new Request(link.url, { headers: { Range: "bytes=0-7" } }), asset.id);
  assert.equal(partial.status, 206); assert.equal((await partial.arrayBuffer()).byteLength, 8);
  const head = await api(new Request(link.url, { method: "HEAD" }), asset.id);
  assert.equal(head.status, 200); assert.equal(head.headers.get("content-length"), String(png.length));
  await assert.rejects(store.resolve({ ownerId: other.id, media: [asset], minimumValidUntil: clock }), { code: "NOT_FOUND" });
  const tampered = new URL(link.url); tampered.searchParams.set("signature", "0".repeat(64));
  assert.equal((await api(new Request(tampered), asset.id)).status, 404);
  const extra = new URL(link.url); extra.searchParams.append("signature", extra.searchParams.get("signature")!);
  assert.equal((await api(new Request(extra), asset.id)).status, 404);
  clock = new Date(clock.getTime() + 7201_000);
  assert.equal((await api(new Request(link.url), asset.id)).status, 404);
  clock = new Date("2026-10-13T12:00:00Z");
});

test("unsupported or corrupt media never becomes available and is removed from storage", async () => {
  const owner = await customer("media-invalid");
  await assert.rejects(store.ingest(owner.id, Buffer.from("<svg><script>secret</script></svg>"), "valid.mp4"), { code: "INVALID_MEDIA" });
  const corruptPixels = Buffer.from(png); corruptPixels[41] = 0;
  await assert.rejects(store.ingest(owner.id, corruptPixels, "valid-header.png"), { code: "INVALID_MEDIA" });
  const before = (await readdir(join(directory, "media"))).length;
  await assert.rejects(store.ingest(owner.id, png.subarray(0, 12)), { code: "INVALID_MEDIA" });
  assert.equal((await readdir(join(directory, "media"))).length, before);
  const small = new SocialMediaStore(db, { directory: join(directory, "media"), origin, signingKey: key, mode: "mock", maxBytes: 1024 });
  await assert.rejects(small.ingest(owner.id, new Uint8Array(1025)), { code: "INVALID_MEDIA" });
});

test("resolver rechecks physical integrity, expiry, deletion and non-symlink storage", async () => {
  const owner = await customer("media-integrity");
  const created = await store.ingest(owner.id, png), asset = await store.owned(owner.id, created.id);
  await db.socialMediaAsset.update({ where: { id: asset.id }, data: { expiresAt: new Date(clock.getTime() + 1000) } });
  await assert.rejects(store.resolve({ ownerId: owner.id, media: [asset], minimumValidUntil: new Date(clock.getTime() + 2000) }), { code: "MEDIA_UNAVAILABLE" });
  await db.socialMediaAsset.update({ where: { id: asset.id }, data: { expiresAt: null } });
  const path = join(directory, "media", asset.storageKey);
  await chmod(path, 0o600); const changed = Buffer.from(png); changed[changed.length - 1] ^= 1; await writeFile(path, changed);
  await assert.rejects(store.resolve({ ownerId: owner.id, media: [asset], minimumValidUntil: clock }), { code: "MEDIA_UNAVAILABLE" });
  const next = await store.ingest(owner.id, png), nextAsset = await store.owned(owner.id, next.id);
  await rm(join(directory, "media", nextAsset.storageKey)); await symlink(path, join(directory, "media", nextAsset.storageKey));
  await assert.rejects(store.resolve({ ownerId: owner.id, media: [nextAsset], minimumValidUntil: clock }), { code: "MEDIA_UNAVAILABLE" });
  await store.remove(owner.id, next.id);
  assert.equal((await store.owned(owner.id, next.id)).status, "DELETED");
});

test("configuration cannot use arbitrary HTTP hosts, relative paths, weak keys or unbounded uploads", () => {
  const defaults = { directory: join(directory, "media"), origin, signingKey: key, mode: "mock" as const };
  for (const overrides of [{ origin: "http://attacker.test" }, { mode: "live" as const }, { directory: "../media" },
    { signingKey: "weak" }, { origin: "https://media.test/path" }, { maxBytes: 1024 ** 3 }])
    assert.throws(() => new SocialMediaStore(db, { ...defaults, ...overrides }), { code: "INVALID_CONFIG" });
});
