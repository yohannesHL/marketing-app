import { AdapterRegistry } from "./AdapterRegistry";
import { AdsPlatformAdapter } from "./AdPlatform.interface";
import { PlatformExecutionResult, PlatformUserAccount } from "./types";

export async function executeAcrossPlatforms<T>(
  accounts: PlatformUserAccount[],
  fn: (adapter: AdsPlatformAdapter) => Promise<T>,
  registry: AdapterRegistry,
): Promise<PlatformExecutionResult<T>[]> {
  const executions = accounts.map(async (account) => {
    try {
      const adapter = registry.create(account.platform);
      await adapter.connect(account);

      const result = await fn(adapter);

      return {
        platform: account.platform,
        accountId: account.id,
        success: true,
        data: result,
      } satisfies PlatformExecutionResult<T>;
    } catch {
      return {
        platform: account.platform,
        accountId: account.id,
        success: false,
        error: {
          message: "The advertising account request could not be completed.",
          code: "ACCOUNT_REQUEST_FAILED",
        },
      } satisfies PlatformExecutionResult<T>;
    }
  });

  return Promise.all(executions);
}

import {
  ConversionEvent,
  CreateAdGroupInput,
  CreateAdInput,
  CreateAssetInput,
  CreateAudienceInput,
  CreateCampaignInput,
  ReachForecastInput,
} from "./types";

export async function executeCampaignCreation(
  accounts: PlatformUserAccount[],
  input: CreateCampaignInput,
  registry: AdapterRegistry,
) {
  return executeAcrossPlatforms(
    accounts,
    (adapter) => adapter.createCampaign(input),
    registry,
  );
}

export async function executeAssetCreation(
  accounts: PlatformUserAccount[],
  assets: CreateAssetInput[],
  registry: AdapterRegistry,
) {
  return executeAcrossPlatforms(
    accounts,
    (adapter) => adapter.createAssets(assets),
    registry,
  );
}

export async function executeAdGroupCreation(
  accounts: PlatformUserAccount[],
  input: CreateAdGroupInput,
  registry: AdapterRegistry,
) {
  return executeAcrossPlatforms(
    accounts,
    (adapter) => adapter.createAdGroup(input),
    registry,
  );
}

export async function executeAdCreation(
  accounts: PlatformUserAccount[],
  ads: CreateAdInput[],
  registry: AdapterRegistry,
) {
  return executeAcrossPlatforms(
    accounts,
    (adapter) => adapter.createAds(ads),
    registry,
  );
}

export async function executeAudienceCreation(
  accounts: PlatformUserAccount[],
  input: CreateAudienceInput,
  registry: AdapterRegistry,
) {
  return executeAcrossPlatforms(
    accounts,
    (adapter) => adapter.createAudience(input),
    registry,
  );
}

export async function executeConversionTracking(
  accounts: PlatformUserAccount[],
  event: ConversionEvent,
  registry: AdapterRegistry,
) {
  return executeAcrossPlatforms(
    accounts,
    (adapter) => adapter.trackConversion(event),
    registry,
  );
}

export async function executeReachForecast(
  accounts: PlatformUserAccount[],
  input: ReachForecastInput,
  registry: AdapterRegistry,
) {
  return executeAcrossPlatforms(
    accounts,
    (adapter) => adapter.forecastReach!(input),
    registry,
  );
}
