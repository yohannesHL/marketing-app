import { randomUUID } from "node:crypto";
import type { Prisma, PrismaClient } from "../../generated/prisma/client";
import { fail, SecurityError } from "../security/errors";

export type ApiBudgetMode = "mock" | "live";
export type ApiBudgetOwnerPolicy = {
  ownerId: string;
  mode: ApiBudgetMode;
  dailyLimitMicros: number;
  deliveryLimitMicros: number;
  /** Explicit operator-configured per-request upper bounds; absent operations are disabled. */
  operationCeilings: Readonly<Record<string, number>>;
};
export type ApiBudgetBinding = {
  ownerId: string;
  deliveryId: string;
  revisionId: string;
  provider: "X";
  mode: ApiBudgetMode;
  authorizationId: string;
  authorizationGeneration: number;
  credentialVersion: number;
  leaseHash: string;
  /** Loaded from the immutable reviewed variant, never copied from the caller's requested cap. */
  reviewedMaxApiCostMicros: number | string;
};
export type ApiBudgetRequest = {
  deliveryId: string;
  mode: ApiBudgetMode;
  operation: string;
  costMicros: number;
  maxApiCostMicros: number;
};
export type ApiBudgetVerification = (
  tx: Prisma.TransactionClient,
) => Promise<ApiBudgetBinding>;
export type ApiConnectionBudgetBinding = {
  approvalId: string;
  ownerId: string;
  sessionId: string;
  mode: ApiBudgetMode;
};
export type ApiConnectionBudgetVerification = (
  tx: Prisma.TransactionClient,
) => Promise<ApiConnectionBudgetBinding>;
const operations = new Set([
  "USER_READ",
  "POST_READ",
  "POST_CREATE",
  "POST_CREATE_URL",
  "POST_DELETE",
  "MEDIA_UPLOAD",
  "MEDIA_INIT",
  "MEDIA_APPEND",
  "MEDIA_FINALIZE",
  "MEDIA_STATUS",
]);
function micros(value: unknown): number {
  const result =
    typeof value === "string" && /^\d{1,15}$/.test(value)
      ? Number(value)
      : value;
  if (typeof result !== "number" || !Number.isSafeInteger(result) || result < 0)
    fail(
      "INVALID_API_COST",
      400,
      "Use a nonnegative safe integer API cost in USD micros.",
    );
  return result;
}
const identifier = (value: unknown) =>
  typeof value === "string" && /^[A-Za-z0-9_-]{1,256}$/.test(value);
function validBinding(binding: ApiBudgetBinding, request: ApiBudgetRequest) {
  if (
    !binding ||
    !identifier(binding.ownerId) ||
    !identifier(binding.deliveryId) ||
    !identifier(binding.revisionId) ||
    !identifier(binding.authorizationId) ||
    binding.deliveryId !== request.deliveryId ||
    binding.mode !== request.mode ||
    binding.provider !== "X" ||
    !Number.isSafeInteger(binding.authorizationGeneration) ||
    binding.authorizationGeneration < 1 ||
    !Number.isSafeInteger(binding.credentialVersion) ||
    binding.credentialVersion < 1 ||
    !/^[a-f0-9]{64}$/.test(binding.leaseHash)
  )
    fail(
      "API_COST_APPROVAL_REQUIRED",
      503,
      "Verify the current owned X delivery before reserving its API budget.",
    );
  if (micros(binding.reviewedMaxApiCostMicros) !== request.maxApiCostMicros)
    fail(
      "API_COST_APPROVAL_REQUIRED",
      409,
      "The requested API ceiling does not match this immutable reviewed revision.",
    );
}
function retryableTransaction(error: unknown) {
  if (error instanceof SecurityError) return false;
  const code =
    typeof error === "object" && error !== null && "code" in error
      ? String(error.code)
      : "";
  return (
    [
      "P2034",
      "SQLITE_BUSY",
      "SQLITE_BUSY_SNAPSHOT",
      "TRANSACTION_CONFLICT",
    ].includes(code) ||
    (code === "P2010" &&
      error instanceof Error &&
      /\bSQLITE_BUSY\b/.test(error.message))
  );
}

/** Monotonic conservative allocations. A reservation is never an assertion that X billed it. */
export class SocialApiBudget {
  private readonly policies = new Map<string, Readonly<ApiBudgetOwnerPolicy>>();
  constructor(
    private readonly db: PrismaClient,
    policies: readonly ApiBudgetOwnerPolicy[],
    private readonly now: () => Date = () => new Date(),
  ) {
    for (const policy of policies) {
      if (
        !identifier(policy.ownerId) ||
        !["mock", "live"].includes(policy.mode) ||
        this.policies.has(`${policy.ownerId}:${policy.mode}`)
      )
        fail(
          "API_COST_APPROVAL_REQUIRED",
          503,
          "Configure explicit owner and mode API budgets.",
        );
      micros(policy.dailyLimitMicros);
      micros(policy.deliveryLimitMicros);
      if (
        !policy.operationCeilings ||
        !Object.keys(policy.operationCeilings).length ||
        Object.entries(policy.operationCeilings).some(
          ([operation, cost]) =>
            !operations.has(operation) ||
            typeof cost !== "number" ||
            !Number.isSafeInteger(cost) ||
            cost < 0,
        )
      )
        fail(
          "API_COST_APPROVAL_REQUIRED",
          503,
          "Configure explicit X operation cost bounds.",
        );
      this.policies.set(
        `${policy.ownerId}:${policy.mode}`,
        Object.freeze({
          ...policy,
          operationCeilings: Object.freeze({ ...policy.operationCeilings }),
        }),
      );
    }
  }
  connectionQuote(
    ownerId: string,
    mode: ApiBudgetMode,
    approvedCapMicros: number,
  ) {
    const cap = micros(approvedCapMicros),
      policy = this.policies.get(`${ownerId}:${mode}`),
      cost = policy?.operationCeilings.USER_READ;
    if (!policy || cost === undefined)
      fail(
        "API_COST_APPROVAL_REQUIRED",
        503,
        "This owner has no X connection-read cost approval.",
      );
    if (
      cap < cost ||
      cap > policy.deliveryLimitMicros ||
      cost > policy.dailyLimitMicros
    )
      fail(
        "API_COST_LIMIT",
        409,
        "Approve a connection ceiling within the configured X read allowance.",
      );
    return {
      userReadCostMicros: cost,
      approvedCapMicros: cap,
      kind: "ESTIMATED_API_ALLOCATION" as const,
    };
  }
  async reserveConnection(
    input: {
      approvalId: string;
      mode: ApiBudgetMode;
      operation: "USER_READ";
      costMicros: number;
    },
    verify: ApiConnectionBudgetVerification,
  ) {
    const request = Object.freeze({ ...input }),
      reservationId = randomUUID(),
      amount = BigInt(micros(request.costMicros));
    if (
      !identifier(request.approvalId) ||
      !["mock", "live"].includes(request.mode) ||
      request.operation !== "USER_READ"
    )
      fail(
        "API_COST_APPROVAL_REQUIRED",
        503,
        "Only the explicitly approved X identity read is permitted.",
      );
    for (let retry = 0; ; retry++) {
      try {
        return await this.db.$transaction(async (tx) => {
          await tx.$executeRawUnsafe(
            'UPDATE "SocialApiBudgetWindow" SET "reservedMicros" = "reservedMicros" WHERE 0',
          );
          const binding = await verify(tx);
          if (
            binding.approvalId !== request.approvalId ||
            binding.mode !== request.mode ||
            !identifier(binding.ownerId) ||
            !identifier(binding.sessionId)
          )
            fail(
              "API_COST_APPROVAL_REQUIRED",
              403,
              "This connection approval does not belong to the current session.",
            );
          const approval = await tx.xConnectionCostApproval.findFirst({
            where: {
              id: binding.approvalId,
              ownerId: binding.ownerId,
              sessionId: binding.sessionId,
              connectionMode: request.mode.toUpperCase(),
              consumedAt: null,
              expiresAt: { gt: this.now() },
            },
          });
          if (!approval)
            fail(
              "API_COST_APPROVAL_REQUIRED",
              409,
              "The X connection cost approval expired or was already used.",
            );
          const quote = this.connectionQuote(
            binding.ownerId,
            binding.mode,
            Number(approval.capMicros),
          );
          if (quote.userReadCostMicros !== request.costMicros)
            fail(
              "API_COST_APPROVAL_REQUIRED",
              503,
              "The identity-read price bound changed. Approve it again.",
            );
          const policy = this.policies.get(
            `${binding.ownerId}:${binding.mode}`,
          )!;
          const allocated =
            (
              await tx.socialApiCostReservation.aggregate({
                where: { connectionApprovalId: approval.id },
                _sum: { costMicros: true },
              })
            )._sum.costMicros ?? 0n;
          if (allocated + amount > approval.capMicros)
            fail(
              "API_COST_LIMIT",
              409,
              "This connection reached its approved API allocation ceiling.",
            );
          const stamp = this.now(),
            windowStart = new Date(
              Date.UTC(
                stamp.getUTCFullYear(),
                stamp.getUTCMonth(),
                stamp.getUTCDate(),
              ),
            );
          const key = {
            ownerId: binding.ownerId,
            provider: "X" as const,
            connectionMode: binding.mode.toUpperCase(),
            windowStart,
          };
          await tx.socialApiBudgetWindow.upsert({
            where: { ownerId_provider_connectionMode_windowStart: key },
            create: key,
            update: { reservedMicros: { increment: 0n } },
          });
          const remaining = BigInt(policy.dailyLimitMicros) - amount;
          if (
            remaining < 0n ||
            !(
              await tx.socialApiBudgetWindow.updateMany({
                where: { ...key, reservedMicros: { lte: remaining } },
                data: { reservedMicros: { increment: amount } },
              })
            ).count
          )
            fail(
              "API_COST_LIMIT",
              409,
              "This owner's daily API allocation ceiling was reached.",
            );
          const current = await verify(tx);
          if (
            current.approvalId !== binding.approvalId ||
            current.ownerId !== binding.ownerId ||
            current.sessionId !== binding.sessionId ||
            current.mode !== binding.mode
          )
            fail(
              "API_COST_APPROVAL_REQUIRED",
              409,
              "The connection approval changed during cost authorization.",
            );
          await tx.socialApiCostReservation.create({
            data: {
              id: reservationId,
              ...key,
              kind: "CONNECTION",
              connectionApprovalId: approval.id,
              operation: request.operation,
              costMicros: amount,
              reviewedCapMicros: approval.capMicros,
              createdAt: stamp,
            },
          });
          return {
            reservationId,
            kind: "ESTIMATED_API_ALLOCATION" as const,
            mode: binding.mode,
          };
        });
      } catch (error) {
        if (!retryableTransaction(error) || retry >= 3) throw error;
        await new Promise((resolve) => setTimeout(resolve, 5 * (retry + 1)));
      }
    }
  }
  async reserve(input: ApiBudgetRequest, verify: ApiBudgetVerification) {
    const request = Object.freeze({ ...input });
    if (
      !identifier(request.deliveryId) ||
      !["mock", "live"].includes(request.mode) ||
      !operations.has(request.operation)
    )
      fail(
        "API_COST_APPROVAL_REQUIRED",
        503,
        "This X operation has no configured API budget approval.",
      );
    const cost = micros(request.costMicros),
      cap = micros(request.maxApiCostMicros),
      reservationId = randomUUID();
    // Keep this ID across retries of this transaction only. Every new HTTP send needs a new reservation.
    for (let retry = 0; ; retry++) {
      try {
        return await this.db.$transaction(async (tx) => {
          // Acquire the SQLite writer before any verifier SELECT can create a
          // competing read snapshot. This avoids read-to-write upgrade deadlocks.
          await tx.$executeRawUnsafe(
            'UPDATE "SocialApiBudgetWindow" SET "reservedMicros" = "reservedMicros" WHERE 0',
          );
          const binding = await verify(tx);
          validBinding(binding, request);
          const policy = this.policies.get(
            `${binding.ownerId}:${binding.mode}`,
          );
          if (
            !policy ||
            policy.operationCeilings[request.operation] === undefined ||
            policy.operationCeilings[request.operation] !== cost
          )
            fail(
              "API_COST_APPROVAL_REQUIRED",
              503,
              "This X operation does not match its configured cost approval.",
            );
          const stamp = this.now();
          if (!Number.isFinite(stamp.getTime()))
            fail(
              "API_COST_APPROVAL_REQUIRED",
              503,
              "The server API budget clock is unavailable.",
            );
          const windowStart = new Date(
              Date.UTC(
                stamp.getUTCFullYear(),
                stamp.getUTCMonth(),
                stamp.getUTCDate(),
              ),
            ),
            connectionMode = binding.mode.toUpperCase(),
            key = {
              ownerId: binding.ownerId,
              provider: "X" as const,
              connectionMode,
              windowStart,
            };
          // This write takes the SQLite write lock before reading lifetime sums.
          await tx.socialApiBudgetWindow.upsert({
            where: { ownerId_provider_connectionMode_windowStart: key },
            create: key,
            update: { reservedMicros: { increment: 0n } },
          });
          const previous = await tx.socialApiCostReservation.findFirst({
            where: { deliveryId: request.deliveryId },
          });
          if (
            previous &&
            (previous.ownerId !== binding.ownerId ||
              previous.provider !== "X" ||
              previous.connectionMode !== connectionMode ||
              previous.revisionId !== binding.revisionId ||
              previous.authorizationId !== binding.authorizationId ||
              previous.authorizationGeneration !==
                binding.authorizationGeneration ||
              previous.reviewedCapMicros !== BigInt(cap))
          )
            fail(
              "API_COST_APPROVAL_REQUIRED",
              409,
              "This delivery's API budget belongs to a different immutable authorization or review.",
            );
          const total = await tx.socialApiCostReservation.aggregate({
            where: { deliveryId: request.deliveryId },
            _sum: { costMicros: true },
          });
          const allocated = total._sum.costMicros ?? 0n,
            amount = BigInt(cost),
            deliveryLimit = BigInt(Math.min(cap, policy.deliveryLimitMicros));
          if (allocated + amount > deliveryLimit)
            fail(
              "API_COST_LIMIT",
              409,
              "This delivery has reached its reviewed API allocation ceiling.",
            );
          const remaining = BigInt(policy.dailyLimitMicros) - amount;
          if (
            remaining < 0n ||
            !(
              await tx.socialApiBudgetWindow.updateMany({
                where: { ...key, reservedMicros: { lte: remaining } },
                data: { reservedMicros: { increment: amount } },
              })
            ).count
          )
            fail(
              "API_COST_LIMIT",
              409,
              "This owner's daily API allocation ceiling was reached.",
            );
          // Recheck lease/revision/grant in the same transaction before the allocation commits.
          const current = await verify(tx);
          validBinding(current, request);
          if (
            current.ownerId !== binding.ownerId ||
            current.revisionId !== binding.revisionId ||
            current.authorizationId !== binding.authorizationId ||
            current.authorizationGeneration !==
              binding.authorizationGeneration ||
            current.credentialVersion !== binding.credentialVersion ||
            current.leaseHash !== binding.leaseHash
          )
            fail(
              "STALE_CREDENTIALS",
              409,
              "The delivery authorization changed during API budget approval.",
            );
          await tx.socialApiCostReservation.create({
            data: {
              id: reservationId,
              ...key,
              deliveryId: request.deliveryId,
              revisionId: binding.revisionId,
              authorizationId: binding.authorizationId,
              authorizationGeneration: binding.authorizationGeneration,
              credentialVersion: binding.credentialVersion,
              leaseHash: binding.leaseHash,
              operation: request.operation,
              costMicros: amount,
              reviewedCapMicros: BigInt(cap),
              createdAt: stamp,
            },
          });
          const window = await tx.socialApiBudgetWindow.findUniqueOrThrow({
            where: { ownerId_provider_connectionMode_windowStart: key },
          });
          return {
            reservationId,
            allocatedDeliveryMicros: (allocated + amount).toString(),
            allocatedDailyMicros: window.reservedMicros.toString(),
            kind: "ESTIMATED_API_ALLOCATION" as const,
            mode: binding.mode,
          };
        });
      } catch (error) {
        if (!retryableTransaction(error) || retry >= 3) throw error;
        // No provider I/O has happened; bounded transaction retries reread all fences.
        await new Promise((resolve) => setTimeout(resolve, 5 * (retry + 1)));
      }
    }
  }
}
