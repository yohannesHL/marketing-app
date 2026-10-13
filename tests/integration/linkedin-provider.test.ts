import assert from "node:assert/strict";
import { before, after, test } from "node:test";
import { LinkedInClient, LINKEDIN_MEMBER_SCOPES, LINKEDIN_ORGANIZATION_SCOPES } from "../../apps/web/src/server/providers/linkedin";
import { startMockoon } from "../support/mockoon";
let mock: Awaited<ReturnType<typeof startMockoon>>;
const now = () => new Date("2026-10-13T12:00:00Z");
const base = { clientId: "li-client", clientSecret: "fixture-li-secret", redirectUri: "https://launchpad.test/api/connections/linkedin/callback", now };
const client = (scopes: readonly string[] = LINKEDIN_MEMBER_SCOPES, patch = {}) => new LinkedInClient({ ...base, scopes,
  mockoonEnabled: true, mockoonBaseUrl: mock.origin, ...patch });
before(async () => { mock = await startMockoon("tests/mockoon/linkedin.json"); });
after(async () => { await mock?.stop(); });

test("LinkedIn confidential OAuth verifies actual scopes and userinfo subject without manufacturing self-serve refresh", async () => {
  const sdk = client();
  const url = new URL(new LinkedInClient({ ...base, scopes: LINKEDIN_MEMBER_SCOPES }).authorizationUrl({ state: "private-session-bound-state" }));
  assert.equal(url.origin, "https://www.linkedin.com"); assert.equal(url.pathname, "/oauth/v2/authorization");
  assert.equal(url.searchParams.get("scope"), LINKEDIN_MEMBER_SCOPES.join(" ")); assert.equal(url.searchParams.get("state"), "private-session-bound-state");
  assert.equal(sdk.pkce, false);
  const grant = await sdk.exchangeCode({ code: "member-code" });
  assert.equal(grant.providerUserId, "member-a"); assert.equal(grant.personUrn, "urn:li:person:member-a");
  assert.equal(grant.refreshToken, undefined); assert.equal(grant.refreshExpiresAt, undefined);
  assert.ok(grant.expiresAt > now());
  await assert.rejects(sdk.exchangeCode({ code: "missing-scope" }), { code: "MISSING_PERMISSION" });
  await assert.rejects(sdk.exchangeCode({ code: "revoked" }), { code: "RECONNECT_REQUIRED" });
});

test("programmatic refresh requires actual MDP credentials and preserves the original refresh lifetime", async () => {
  const sdk = client(LINKEDIN_MEMBER_SCOPES, { mdpRefreshEnabled: true });
  const original = await sdk.exchangeCode({ code: "mdp-code" });
  assert.equal(original.refreshToken, "mdp-refresh");
  const previousExpiry = new Date(now().getTime() + 3600_000);
  const renewed = await sdk.renewVerified({ providerUserId: original.providerUserId, refreshToken: original.refreshToken!, refreshExpiresAt: previousExpiry, scopes: original.scopes });
  assert.equal(renewed.refreshToken, "mdp-refresh-rotated"); assert.equal(renewed.refreshExpiresAt!.toISOString(), previousExpiry.toISOString());
  await assert.rejects(client().renewVerified({ providerUserId: original.providerUserId, refreshToken: "mdp-refresh", refreshExpiresAt: previousExpiry, scopes: original.scopes }), { code: "RECONNECT_REQUIRED" });
  await assert.rejects(sdk.renewVerified({ providerUserId: original.providerUserId, refreshToken: "mdp-refresh", refreshExpiresAt: now(), scopes: original.scopes }), { code: "RECONNECT_REQUIRED" });
});

test("fresh organic author approval distinguishes the member, company Page, DSC-only roles and missing restricted read", async () => {
  const sdk = client();
  assert.equal((await sdk.verifyAuthor("member-token", { providerUserId: "member-a", authorUrn: "urn:li:person:member-a" })).authorUrn, "urn:li:person:member-a");
  await assert.rejects(sdk.verifyAuthor("member-token", { providerUserId: "member-b", authorUrn: "urn:li:person:member-a" }), { code: "PROVIDER_IDENTITY_MISMATCH" });
  await assert.rejects(sdk.verifyAuthor("member-token", { providerUserId: "member-a", authorUrn: "urn:li:person:member-b" }), { code: "AUTHOR_MISMATCH" });
  await assert.rejects(sdk.verifyAuthor("selfserve-token", { providerUserId: "member-a", authorUrn: "urn:li:person:member-a" }), { code: "READ_CAPABILITY_REQUIRED" });
  const organization = client(LINKEDIN_ORGANIZATION_SCOPES);
  assert.equal((await organization.verifyAuthor("org-token", { providerUserId: "member-a", authorUrn: "urn:li:organization:123" })).authorUrn, "urn:li:organization:123");
  for (const token of ["dsc-token", "revoked-role-token"])
    await assert.rejects(organization.verifyAuthor(token, { providerUserId: "member-a", authorUrn: "urn:li:organization:123" }), { code: "ORGANIZATION_ROLE_REQUIRED" });
});

const member = { providerUserId: "member-a", authorUrn: "urn:li:person:member-a" };
const organization = { providerUserId: "member-a", authorUrn: "urn:li:organization:123" };
test("image and video upload plans retain private URLs, exact owner, expiry and final part ETag before processing readiness", async () => {
  const sdk = client();
  const image = await sdk.initializeImage("member-token", member);
  assert.equal(image.mediaUrn, "urn:li:image:fixtureMember");
  await sdk.uploadImage("member-token", member, image, new Uint8Array(8));
  assert.equal((await sdk.mediaStatus("member-token", member, image.mediaUrn)).status, "AVAILABLE");
  const video = await sdk.initializeVideo("member-token", member, 80000);
  assert.equal(video.parts[0].lastByte, 79999);
  const etag = await sdk.uploadPart("member-token", member, video, 0, new Uint8Array(80000));
  assert.equal(etag, "etag-fixture-Member");
  await sdk.finalizeVideo("member-token", member, video, [etag]);
  assert.equal((await sdk.mediaStatus("member-token", member, video.mediaUrn)).status, "AVAILABLE");
  assert.equal((await sdk.mediaStatus("member-token", member, "urn:li:video:processing")).status, "PROCESSING");
  assert.equal((await sdk.mediaStatus("member-token", member, "urn:li:video:failed")).status, "PROCESSING_FAILED");
  await assert.rejects(sdk.mediaStatus("member-token", member, "urn:li:image:foreign"), { code: "AUTHOR_MISMATCH" });
  await assert.rejects(sdk.uploadPart("member-token", member, video, 0, new Uint8Array(7)), { code: "INVALID_MEDIA" });
  await assert.rejects(sdk.uploadImage("member-token", member, { ...image, expiresAt: now().getTime() }, new Uint8Array(8)), { code: "MEDIA_EXPIRED" });
  await assert.rejects(sdk.uploadImage("member-token", member, { ...image, uploadUrl: "https://attacker.test/dms-uploads/private" }, new Uint8Array(8)), { code: "INVALID_UPLOAD_URL" });
  const orgSdk = client(LINKEDIN_ORGANIZATION_SCOPES);
  const orgImage = await orgSdk.initializeImage("org-token", organization);
  assert.equal(orgImage.ownerUrn, organization.authorUrn);
  await assert.rejects(sdk.uploadImage("member-token", member, orgImage, new Uint8Array(8)), { code: "AUTHOR_MISMATCH" });
  await orgSdk.uploadImage("org-token", organization, orgImage, new Uint8Array(8));
  assert.equal((await orgSdk.mediaStatus("org-token", organization, orgImage.mediaUrn)).status, "AVAILABLE");
  const orgVideo = await orgSdk.initializeVideo("org-token", organization, 80000);
  const orgTag = await orgSdk.uploadPart("org-token", organization, orgVideo, 0, new Uint8Array(80000));
  await orgSdk.finalizeVideo("org-token", organization, orgVideo, [orgTag]);
  assert.equal((await orgSdk.mediaStatus("org-token", organization, orgVideo.mediaUrn)).status, "AVAILABLE");
});

test("Posts API sends explicit author/visibility and returns an accepted ID independently of confirmed lifecycle", async () => {
  const sdk = client();
  const created = await sdk.createPost("member-token", member, { commentary: "Text fixture", visibility: "CONNECTIONS" });
  assert.equal(created.postUrn, "urn:li:share:101");
  assert.equal((await sdk.postStatus("member-token", member, created.postUrn)).state, "PUBLISHED");
  assert.equal((await sdk.createPost("member-token", member, { commentary: "Hello [team] #tag", visibility: "PUBLIC" })).postUrn, "urn:li:share:107");
  for (const [commentary, id, state] of [["Pending fixture", "urn:li:share:102", "PENDING"], ["Failed fixture", "urn:li:share:103", "FAILED"]]) {
    const accepted = await sdk.createPost("member-token", member, { commentary, visibility: "PUBLIC" });
    assert.equal(accepted.postUrn, id);
    assert.equal((await sdk.reconcileKnown("member-token", member, id)).state, state);
  }
  assert.deepEqual(await sdk.reconcileKnown("member-token", member), { state: "UNKNOWN" });
  await assert.rejects(sdk.postStatus("member-token", member, "urn:li:share:199"), { code: "AUTHOR_MISMATCH" });
  const org = client(LINKEDIN_ORGANIZATION_SCOPES);
  assert.equal((await org.createPost("org-token", organization, { commentary: "Organization fixture", visibility: "PUBLIC" })).postUrn, "urn:li:share:201");
  await assert.rejects(org.createPost("org-token", organization, { commentary: "Organization fixture", visibility: "CONNECTIONS" }), { code: "INVALID_CONTENT" });
  await assert.rejects(sdk.createPost("selfserve-token", member, { commentary: "Text fixture", visibility: "PUBLIC" }), { code: "READ_CAPABILITY_REQUIRED" });
});

test("image/video posts require owned AVAILABLE media and unknown, timeout and quota receipts never become success", async () => {
  const sdk = client();
  for (const [commentary, mediaUrn, id] of [["Image fixture", "urn:li:image:fixtureMember", "urn:li:share:105"], ["Video fixture", "urn:li:video:fixtureMember", "urn:li:share:106"]])
    assert.equal((await sdk.createPost("member-token", member, { commentary, visibility: "PUBLIC", mediaUrn })).postUrn, id);
  for (const mediaUrn of ["urn:li:image:foreign", "urn:li:video:processing", "urn:li:video:failed"])
    await assert.rejects(sdk.createPost("member-token", member, { commentary: "Video fixture", visibility: "PUBLIC", mediaUrn }));
  await assert.rejects(sdk.createPost("member-token", member, { commentary: "missing-id fixture", visibility: "PUBLIC" }), { code: "PROVIDER_OUTCOME_UNKNOWN", outcomeUnknown: true });
  await assert.rejects(client(LINKEDIN_MEMBER_SCOPES, { requestTimeoutMs: 1000 }).createPost("member-token", member, { commentary: "timeout fixture", visibility: "PUBLIC" }), { code: "PROVIDER_OUTCOME_UNKNOWN", outcomeUnknown: true });
  await assert.rejects(sdk.createPost("member-token", member, { commentary: "quota fixture", visibility: "PUBLIC" }), (error: unknown) => !!error && typeof error === "object" && "code" in error && error.code === "PROVIDER_RATE_LIMITED" && !String(error).includes("private-provider-secret"));
  await assert.rejects(sdk.deleteKnownPost("member-token", member, "urn:li:share:199"), { code: "AUTHOR_MISMATCH" });
  assert.deepEqual(await sdk.deleteKnownPost("member-token", member, "urn:li:share:101"), { deleted: true });
});

test("organization discovery paginates current approved assignments and filters DSC-only authors using organic authorization", async () => {
  const discovered = await client(LINKEDIN_ORGANIZATION_SCOPES).discoverOrganizations("org-token", { providerUserId: "member-a" });
  assert.deepEqual(discovered.map((row) => row.authorUrn), ["urn:li:organization:123"]);
  await assert.rejects(client().discoverOrganizations("member-token", { providerUserId: "member-a" }), { code: "MISSING_PERMISSION" });
});

test("explicit loopback mocks and per-request durable guards never fall back to live or continue with changed credentials", async () => {
  for (const patch of [{ mockoonBaseUrl: mock.origin, mockoonEnabled: false }, { mockoonBaseUrl: mock.origin, mockoonEnabled: "false" },
    { mockoonEnabled: true, mockoonBaseUrl: "https://attacker.test" }, { redirectUri: "http://external.test/callback" }, { version: "202510" }])
    assert.throws(() => new LinkedInClient({ ...base, scopes: LINKEDIN_MEMBER_SCOPES, ...patch } as never), { code: "INVALID_CONFIG" });
  let checks = 0; const stale = Object.assign(new Error("The grant changed."), { code: "STALE_CREDENTIALS" });
  await assert.rejects(client(LINKEDIN_MEMBER_SCOPES, { beforeRequest: async () => { if (++checks === 2) throw stale; } }).exchangeCode({ code: "member-code" }), (error: unknown) => error === stale);
  assert.equal(checks, 2);
});

test("multipart video preserves provider byte ranges and ordered opaque ETags; restricted media reads fail closed", async () => {
  const sdk = client(), plan = await sdk.initializeVideo("member-token", member, 4194311);
  assert.deepEqual(plan.parts.map((p) => [p.firstByte, p.lastByte]), [[0, 4194303], [4194304, 4194310]]);
  const tags: string[] = [];
  for (let i = 0; i < plan.parts.length; i++) tags.push(await sdk.uploadPart("member-token", member, plan, i,
    new Uint8Array(plan.parts[i].lastByte - plan.parts[i].firstByte + 1)));
  assert.deepEqual(tags, ["/ambry-videoei/signedId/part-0.bin", "opaque-part-1"]);
  await assert.rejects(sdk.finalizeVideo("member-token", member, plan, [...tags].reverse()), { code: "PROVIDER_REQUEST_FAILED" });
  await sdk.finalizeVideo("member-token", member, plan, tags);
  assert.equal((await sdk.mediaStatus("member-token", member, plan.mediaUrn)).status, "AVAILABLE");
  await assert.rejects(sdk.mediaStatus("member-token", member, "urn:li:image:no-read"), { code: "MISSING_PERMISSION" });
});
