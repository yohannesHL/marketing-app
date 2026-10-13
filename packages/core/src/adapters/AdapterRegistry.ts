import { AdsPlatformAdapter } from "./AdPlatform.interface";
import { Platform } from "./types";

export class AdapterRegistry {
  private adapters = new Map<Platform, AdsPlatformAdapter>();

  register(adapter: AdsPlatformAdapter) {
    this.adapters.set(adapter.platform, adapter);
  }

  get(platform: Platform): AdsPlatformAdapter {
    const adapter = this.adapters.get(platform);
    if (!adapter) throw new Error(`Adapter not found: ${platform}`);
    return adapter;
  }
}
