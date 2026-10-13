import { AdsPlatformAdapter } from "./AdPlatform.interface";
import { Platform } from "./types";

export class AdapterRegistry {
  private adapters = new Map<Platform, AdsPlatformAdapter>();
  private factories = new Map<Platform, () => AdsPlatformAdapter>();
  private issuedAdapters = new WeakSet<AdsPlatformAdapter>();

  register(adapter: AdsPlatformAdapter) {
    this.factories.delete(adapter.platform);
    this.adapters.set(adapter.platform, adapter);
  }

  registerFactory(platform: Platform, factory: () => AdsPlatformAdapter) {
    this.adapters.delete(platform);
    this.factories.set(platform, factory);
  }

  /** Every concurrent account invocation must receive its own mutable adapter. */
  create(platform: Platform): AdsPlatformAdapter {
    const factory = this.factories.get(platform);
    if (!factory) throw new Error("Configure an account-isolated advertising adapter factory.");
    const adapter = factory();
    if (adapter.platform !== platform) throw new Error("The advertising adapter factory returned another platform.");
    if (this.issuedAdapters.has(adapter)) throw new Error("An advertising adapter instance cannot be reused across accounts.");
    this.issuedAdapters.add(adapter);
    return adapter;
  }

  get(platform: Platform): AdsPlatformAdapter {
    let adapter = this.adapters.get(platform);
    if (!adapter && this.factories.has(platform)) {
      adapter = this.create(platform);
      this.adapters.set(platform, adapter);
    }
    if (!adapter) throw new Error(`Adapter not found: ${platform}`);
    return adapter;
  }
}
