import {
  buildRegistry,
  type CreateAssetInput,
  type CreateCampaignInput,
  type PlatformExecutionResult,
} from "@launchpad/core";
import type { CustomerPrincipal } from "../../auth/customerAuth";
import { withCustomerAdAccount } from "../repositories/adsAccountsRepository";
import { fail } from "../../security/errors";

async function forSelectedAccounts<T>(
  principal: CustomerPrincipal,
  destinationIds: string[],
  invoke: (
    adapter: ReturnType<typeof buildRegistry>,
    platform: "GOOGLE" | "META" | "TIKTOK" | "LINKEDIN" | "X",
  ) => Promise<T>,
): Promise<PlatformExecutionResult<T>[]> {
  if (
    !Array.isArray(destinationIds) ||
    !destinationIds.length ||
    destinationIds.length > 20 ||
    destinationIds.some((id) => typeof id !== "string")
  ) {
    fail(
      "INVALID_SELECTION",
      400,
      "Select the customer destinations explicitly.",
    );
  }
  return Promise.all(
    [...new Set(destinationIds)].map((id) =>
      withCustomerAdAccount(principal, id, async (account) => {
        // Each account gets its own adapter instance; connect() contains mutable credentials.
        const registry = buildRegistry([account.platform]);
        await registry.get(account.platform).connect(account);
        return {
          platform: account.platform,
          success: true,
          data: await invoke(registry, account.platform),
        };
      }),
    ),
  );
}

export async function executeCreateCampaign(input: {
  principal: CustomerPrincipal;
  destinationIds: string[];
  payload: CreateCampaignInput;
}) {
  return forSelectedAccounts(
    input.principal,
    input.destinationIds,
    (registry, platform) =>
      registry
        .get(platform)
        .createCampaign({ ...input.payload, userId: input.principal.userId }),
  );
}

export async function executeCreateAssets(input: {
  principal: CustomerPrincipal;
  destinationIds: string[];
  payload: CreateAssetInput[];
}) {
  return forSelectedAccounts(
    input.principal,
    input.destinationIds,
    (registry, platform) => registry.get(platform).createAssets(input.payload),
  );
}
