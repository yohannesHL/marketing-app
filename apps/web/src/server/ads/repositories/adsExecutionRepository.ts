import type { Prisma } from "../../../generated/prisma/client";

import { prisma } from "../../prisma/client";
import { redact } from "../../security/redact";

export async function createExecution(input: {
  operation: string;
  source?: string;
  requestPayload: Prisma.InputJsonValue;
  ownerId: string;
}) {
  return prisma.adProxyExecution.create({
    data: {
      operation: input.operation,
      source: input.source,
      ownerId: input.ownerId,
      requestPayload: redact(input.requestPayload) as Prisma.InputJsonValue,
    },
  });
}

export async function createInvocations(input: {
  executionId: string;
  platforms: string[];
  adapterPayload: Prisma.InputJsonValue;
}) {
  return Promise.all(
    input.platforms.map((platform) =>
      prisma.adPlatformInvocation.create({
        data: {
          executionId: input.executionId,
          platform: platform as never,
          adapterPayload: redact(input.adapterPayload) as Prisma.InputJsonValue,
        },
      }),
    ),
  );
}

export async function recordDownstreamCall(input: {
  invocationId: string;
  downstreamPath: string;
  downstreamRequest: Prisma.InputJsonValue;
  downstreamResponse: Prisma.InputJsonValue;
}) {
  return prisma.adPlatformInvocation.update({
    where: { id: input.invocationId },
    data: {
      downstreamPath: redact(input.downstreamPath) as string,
      downstreamRequest: redact(
        input.downstreamRequest,
      ) as Prisma.InputJsonValue,
      downstreamResponse: redact(
        input.downstreamResponse,
      ) as Prisma.InputJsonValue,
    },
  });
}

export async function completeInvocation(input: {
  invocationId: string;
  success: boolean;
  errorMessage?: string;
}) {
  return prisma.adPlatformInvocation.update({
    where: { id: input.invocationId },
    data: {
      success: input.success,
      errorMessage: input.errorMessage
        ? "The platform operation failed."
        : undefined,
      completedAt: new Date(),
    },
  });
}

export async function completeExecution(input: {
  executionId: string;
  success: boolean;
  responsePayload: Prisma.InputJsonValue;
}) {
  return prisma.adProxyExecution.update({
    where: { id: input.executionId },
    data: {
      success: input.success,
      responsePayload: redact(input.responsePayload) as Prisma.InputJsonValue,
      completedAt: new Date(),
    },
  });
}

export async function getExecution(executionId: string, ownerId: string) {
  return prisma.adProxyExecution.findFirst({
    where: { id: executionId, ownerId },
    include: {
      invocations: {
        orderBy: { createdAt: "asc" },
      },
    },
  });
}
