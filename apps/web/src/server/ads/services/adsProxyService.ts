import {
  AdapterRegistry,
  executeAssetCreation,
  executeCampaignCreation,
  GoogleAdsAdapter,
  MetaAdsAdapter,
  TikTokAdsAdapter,
  type CreateAssetInput,
  type CreateCampaignInput,
  type PlatformAccount,
} from "@launchpad/core";
import type { Prisma } from "../../../generated/prisma/client";

import {
  completeExecution,
  completeInvocation,
  createExecution,
  createInvocations,
  getExecution,
} from "../repositories/adsExecutionRepository";

const SUPPORTED_PROXY_PLATFORMS = ["GOOGLE", "META", "TIKTOK"] as const;

type SupportedProxyPlatform = (typeof SUPPORTED_PROXY_PLATFORMS)[number];
type ProxyOperation = "createCampaign" | "createAssets";

type MockAdapterContext = {
  invocationId: string;
  operation: ProxyOperation;
  cookie: string;
};

function getInternalBaseUrl() {
  if (process.env.INTERNAL_BASE_URL) {
    return process.env.INTERNAL_BASE_URL;
  }

  if (process.env.BASE_URL) {
    return process.env.BASE_URL;
  }

  const host =
    process.env.HOSTNAME && process.env.HOSTNAME !== "0.0.0.0"
      ? process.env.HOSTNAME
      : "127.0.0.1";
  const port = process.env.PORT ?? "3000";

  return `http://${host}:${port}`;
}

class MockGoogleAdsAdapter extends GoogleAdsAdapter {
  constructor(private readonly context: MockAdapterContext) {
    super();
  }

  protected async request<T>(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<T> {
    const response = await fetch(
      `${getInternalBaseUrl()}/api/mock-ads/google`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Cookie: this.context.cookie,
          Origin: process.env.APP_ORIGIN ?? "",
          "x-ads-invocation-id": this.context.invocationId,
          "x-ads-operation": this.context.operation,
          "x-ads-platform": "GOOGLE",
        },
        body: JSON.stringify({ method, path, body }),
        cache: "no-store",
      },
    );

    if (!response.ok) throw new Error("The mock platform request failed.");
    return response.json() as Promise<T>;
  }
}

class MockMetaAdsAdapter extends MetaAdsAdapter {
  constructor(private readonly context: MockAdapterContext) {
    super();
  }

  protected async request<T>(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<T> {
    const response = await fetch(`${getInternalBaseUrl()}/api/mock-ads/meta`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: this.context.cookie,
        Origin: process.env.APP_ORIGIN ?? "",
        "x-ads-invocation-id": this.context.invocationId,
        "x-ads-operation": this.context.operation,
        "x-ads-platform": "META",
      },
      body: JSON.stringify({ method, path, body }),
      cache: "no-store",
    });

    if (!response.ok) throw new Error("The mock platform request failed.");
    return response.json() as Promise<T>;
  }
}

class MockTikTokAdsAdapter extends TikTokAdsAdapter {
  constructor(private readonly context: MockAdapterContext) {
    super();
  }

  protected async request<T>(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<T> {
    const response = await fetch(
      `${getInternalBaseUrl()}/api/mock-ads/tiktok`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Cookie: this.context.cookie,
          Origin: process.env.APP_ORIGIN ?? "",
          "x-ads-invocation-id": this.context.invocationId,
          "x-ads-operation": this.context.operation,
          "x-ads-platform": "TIKTOK",
        },
        body: JSON.stringify({ method, path, body }),
        cache: "no-store",
      },
    );

    if (!response.ok) throw new Error("The mock platform request failed.");
    return response.json() as Promise<T>;
  }
}

function normalizePlatforms(platforms?: string[]): SupportedProxyPlatform[] {
  if (!platforms || platforms.length === 0) {
    return [...SUPPORTED_PROXY_PLATFORMS];
  }

  return platforms.filter((platform): platform is SupportedProxyPlatform =>
    SUPPORTED_PROXY_PLATFORMS.includes(platform as SupportedProxyPlatform),
  );
}

function buildAccounts(platforms: SupportedProxyPlatform[], userId: string) {
  return platforms.map((platform) => ({
    id: `mock-${platform.toLowerCase()}`,
    userId,
    platform,
    externalId: `mock-${platform.toLowerCase()}-account`,
    name: `${platform} Mock Account`,
    currency: "USD",
    timezone: "UTC",
    accessToken: `mock-token-${platform.toLowerCase()}`,
  }));
}

function buildRegistry(
  invocationByPlatform: Map<SupportedProxyPlatform, { id: string }>,
  operation: ProxyOperation,
  cookie: string,
) {
  const registry = new AdapterRegistry();

  if (invocationByPlatform.has("GOOGLE"))
    registry.register(
      new MockGoogleAdsAdapter({
        invocationId: invocationByPlatform.get("GOOGLE")!.id,
        operation,
        cookie,
      }),
    );
  if (invocationByPlatform.has("META"))
    registry.register(
      new MockMetaAdsAdapter({
        invocationId: invocationByPlatform.get("META")!.id,
        operation,
        cookie,
      }),
    );
  if (invocationByPlatform.has("TIKTOK"))
    registry.register(
      new MockTikTokAdsAdapter({
        invocationId: invocationByPlatform.get("TIKTOK")!.id,
        operation,
        cookie,
      }),
    );

  return registry;
}

function indexInvocations<T extends { id: string; platform: string }>(
  invocations: T[],
) {
  return new Map(
    invocations.map((invocation): [SupportedProxyPlatform, T] => [
      invocation.platform as SupportedProxyPlatform,
      invocation,
    ]),
  );
}

function toJsonValue(value: unknown): Prisma.InputJsonValue {
  return value as Prisma.InputJsonValue;
}

async function finalizeExecution(
  executionId: string,
  ownerId: string,
  results: Array<{ success: boolean }>,
  responsePayload: Record<string, unknown>,
) {
  await completeExecution({
    executionId,
    success: results.every((result) => result.success),
    responsePayload: toJsonValue(responsePayload),
  });

  const execution = await getExecution(executionId, ownerId);

  if (execution === null) {
    throw new Error("Unable to reload the persisted ads execution log.");
  }

  const uniformPayload =
    execution.invocations.length > 0 &&
    execution.invocations.every(
      (invocation: (typeof execution.invocations)[number]) =>
        JSON.stringify(invocation.adapterPayload) ===
        JSON.stringify(execution.invocations[0]?.adapterPayload),
    );

  return {
    executionId,
    operation: execution.operation,
    success: execution.success,
    message: `Uniform adapter payload confirmed across ${execution.invocations.length} platform calls.`,
    uniformPayload,
    platformsInvoked: execution.invocations.map(
      (invocation: (typeof execution.invocations)[number]) =>
        invocation.platform,
    ),
    results,
    invocations: execution.invocations,
  };
}

export async function executeCreateCampaign(input: {
  payload: CreateCampaignInput;
  platforms?: string[];
  source?: string;
  ownerId: string;
  cookie: string;
}) {
  const platforms = normalizePlatforms(input.platforms);

  if (platforms.length === 0) {
    throw new Error("At least one supported proxy platform is required.");
  }

  const execution = await createExecution({
    operation: "createCampaign",
    ownerId: input.ownerId,
    source: input.source,
    requestPayload: toJsonValue(input.payload),
  });

  const invocations = await createInvocations({
    executionId: execution.id,
    platforms,
    adapterPayload: toJsonValue(input.payload),
  });

  const invocationByPlatform = indexInvocations(invocations);
  const registry = buildRegistry(
    invocationByPlatform,
    "createCampaign",
    input.cookie,
  );
  const accounts = buildAccounts(platforms, input.ownerId);
  const results = await executeCampaignCreation(
    accounts,
    input.payload,
    registry,
  );

  await Promise.all(
    results.map((result) =>
      completeInvocation({
        invocationId: invocationByPlatform.get(
          result.platform as SupportedProxyPlatform,
        )!.id,
        success: result.success,
        errorMessage: result.error?.message,
      }),
    ),
  );

  return finalizeExecution(execution.id, input.ownerId, results, {
    operation: "createCampaign",
    platforms,
    results,
  });
}

export async function executeCreateAssets(input: {
  payload: CreateAssetInput[];
  platforms?: string[];
  source?: string;
  ownerId: string;
  cookie: string;
}) {
  const platforms = normalizePlatforms(input.platforms);

  if (platforms.length === 0) {
    throw new Error("At least one supported proxy platform is required.");
  }

  const execution = await createExecution({
    operation: "createAssets",
    ownerId: input.ownerId,
    source: input.source,
    requestPayload: toJsonValue(input.payload),
  });

  const invocations = await createInvocations({
    executionId: execution.id,
    platforms,
    adapterPayload: toJsonValue(input.payload),
  });

  const invocationByPlatform = indexInvocations(invocations);
  const registry = buildRegistry(
    invocationByPlatform,
    "createAssets",
    input.cookie,
  );
  const accounts = buildAccounts(platforms, input.ownerId);
  const results = await executeAssetCreation(accounts, input.payload, registry);

  await Promise.all(
    results.map((result) =>
      completeInvocation({
        invocationId: invocationByPlatform.get(
          result.platform as SupportedProxyPlatform,
        )!.id,
        success: result.success,
        errorMessage: result.error?.message,
      }),
    ),
  );

  return finalizeExecution(execution.id, input.ownerId, results, {
    operation: "createAssets",
    platforms,
    results,
  });
}

export async function getPersistedExecution(
  executionId: string,
  ownerId: string,
) {
  return getExecution(executionId, ownerId);
}
