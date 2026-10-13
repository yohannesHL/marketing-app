// ===============================
// exampleUsage.ts
// ===============================
import { AdapterRegistry } from "./adapterRegistry";
import { GoogleAdsAdapter } from "./googleAdapter";
import { MetaAdsAdapter } from "./metaAdapter";
import { TikTokAdsAdapter } from "./tikTokAdapter";
import {
  CreateAdGroupInput,
  CreateAdInput,
  CreateAssetInput,
  CreateCampaignInput,
  executeAdCreation,
  executeAdGroupCreation,
  executeAssetCreation,
  executeCampaignCreation,
  PlatformAccount,
  PlatformExecutionResult,
} from "./types";

// -------------------------------
// 1. Create accounts for each platform
// -------------------------------
const accounts: PlatformAccount[] = [
  {
    id: "1",
    platform: "GOOGLE",
    externalId: "1234567890", // customerId
    name: "Google Test Account",
    accessToken: process.env.GOOGLE_ACCESS_TOKEN!,
  },
  {
    id: "2",
    platform: "META",
    externalId: "9876543210", // adAccountId
    name: "Meta Test Account",
    accessToken: process.env.META_ACCESS_TOKEN!,
  },
  {
    id: "3",
    platform: "TIKTOK",
    externalId: "5555555555", // advertiserId
    name: "TikTok Test Account",
    accessToken: process.env.TIKTOK_ACCESS_TOKEN!,
  },
];

// -------------------------------
// 2. Register adapters
// -------------------------------
const registry = new AdapterRegistry();
registry.register(new GoogleAdsAdapter());
registry.register(new MetaAdsAdapter());
registry.register(new TikTokAdsAdapter());

// -------------------------------
// 3. Prepare input data
// -------------------------------
const assets: CreateAssetInput[] = [
  { name: "Test Image", type: "IMAGE", url: "https://example.com/test.png" },
];

const campaignInput: CreateCampaignInput = {
  name: "Multi-Platform Campaign",
  objective: "CLICKS",
  budget: { dailyBudget: 50, currency: "USD" },
};

const adGroupInput: CreateAdGroupInput = {
  name: "AdGroup 1",
  campaignId: "", // will be filled dynamically after campaign creation
  budget: 25,
};

const adInput: CreateAdInput[] = [
  {
    adGroupId: "",
    type: "RESPONSIVE",
    assetIds: [],
    headline: "Test Headline",
    description: "Test Description",
    landingPageUrl: "https://example.com",
  },
];

// -------------------------------
// 4. Execute asset creation
// -------------------------------
async function run() {
  console.log("Creating assets across platforms...");
  const assetResults: PlatformExecutionResult<any>[] =
    await executeAssetCreation(accounts, assets, registry);
  console.log("Asset Results:", assetResults);

  // Extract first successful assetId per platform
  const assetIdsPerPlatform = new Map<string, string>();
  assetResults.forEach((res) => {
    if (res.success && res.data && res.data.length > 0) {
      assetIdsPerPlatform.set(res.platform, res.data[0].externalId);
    }
  });

  // -------------------------------
  // 5. Create campaigns
  // -------------------------------
  console.log("Creating campaigns across platforms...");
  const campaignResults = await executeCampaignCreation(
    accounts,
    campaignInput,
    registry,
  );
  console.log("Campaign Results:", campaignResults);

  // -------------------------------
  // 6. Create ad groups
  // -------------------------------
  console.log("Creating ad groups across platforms...");
  const adGroupResults: PlatformExecutionResult<any>[] =
    await executeAdGroupCreation(
      accounts.map((a) => ({ ...a })),
      adGroupInput,
      registry,
    );
  console.log("AdGroup Results:", adGroupResults);

  // -------------------------------
  // 7. Create ads
  // -------------------------------
  console.log("Creating ads across platforms...");
  const adsWithIds: CreateAdInput[] = adInput.map((ad) => {
    const platform = "GOOGLE"; // Example, replace dynamically per platform
    const assetId = assetIdsPerPlatform.get(platform);
    const adGroup = adGroupResults.find((r) => r.platform === platform)?.data
      ?.externalId;
    return { ...ad, adGroupId: adGroup!, assetIds: assetId ? [assetId] : [] };
  });
  const adResults = await executeAdCreation(accounts, adsWithIds, registry);
  console.log("Ad Results:", adResults);
}

run().catch((err) => console.error(err));
