import assert from "node:assert/strict";
import test from "node:test";
import { safeReturnTo } from "../../apps/web/src/components/connections/connectionUi";
test("workspace sign-in returns to approved app routes with draft context",()=>{
  assert.equal(safeReturnTo(null),"/dashboard");
  for(const path of ["/dashboard","/campaigns","/studio","/studio/brand","/campaigns/audiences","/connections","/social"])
    assert.equal(safeReturnTo(path),path);
  assert.equal(safeReturnTo("/campaigns/create?id=campaign_123&step=4"),"/campaigns/create?id=campaign_123&step=4");
  assert.equal(safeReturnTo("/social/create?campaignId=campaign_123&assetId=asset_123"),"/social/create?campaignId=campaign_123&assetId=asset_123");
});
test("workspace sign-in cannot redirect off-site or forward arbitrary queries",()=>{
  for(const path of ["//evil.test","/\\evil.test","https://evil.test","javascript:alert(1)","/api/auth/session","/campaigns/%2f%2fevil.test"])
    assert.equal(safeReturnTo(path),"/dashboard");
  assert.equal(safeReturnTo("/social/create?token=private&id=valid&campaignId=https://evil.test"),"/social/create?id=valid");
});
