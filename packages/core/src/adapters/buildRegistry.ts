import { AdapterRegistry } from "./AdapterRegistry";
import { GoogleAdsAdapter } from "./GoogleAdsAdapter";
import { MetaAdsAdapter } from "./MetaAdsAdapter";
import { TikTokAdsAdapter } from "./TikTokAdsAdapter";
import { Platform } from "./types";
import type { AdsPlatformAdapter } from "./AdPlatform.interface";

export function buildRegistry(platforms: Platform[]) {
  const registry = new AdapterRegistry();
  const platformAdaptors: Partial<
    Record<Platform, new () => AdsPlatformAdapter>
  > = {
    GOOGLE: GoogleAdsAdapter,
    META: MetaAdsAdapter,
    TIKTOK: TikTokAdsAdapter,
    // X: XAdsAdapter,
  };

  for (const platform of platforms) {
    const Adapter = platformAdaptors[platform];
    if (Adapter) registry.register(new Adapter());
  }

  return registry;
}
