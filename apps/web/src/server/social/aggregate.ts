import type { Prisma } from "../../generated/prisma/client";

/** Resolve only the current scheduled revision; historical jobs cannot rewrite a draft. */
export async function aggregateSocialPostStatus(tx: Prisma.TransactionClient, postId: string, expectedGeneration?: number) {
  const post = await tx.socialPost.findUnique({ where: { id: postId } });
  if (!post || post.status !== "SCHEDULED" || (expectedGeneration !== undefined && post.generation !== expectedGeneration)) return;
  const deliveries = await tx.socialDelivery.findMany({ where: { postId, postGeneration: post.generation, revision: { number: post.currentRevision } }, select: { status: true } });
  if (!deliveries.length || deliveries.some((d) => !["SUCCEEDED", "CANCELLED", "SUPERSEDED"].includes(d.status))) return;
  await tx.socialPost.updateMany({ where: { id: postId, generation: post.generation, currentRevision: post.currentRevision, status: "SCHEDULED" },
    data: { status: deliveries.some((d) => d.status === "SUCCEEDED") ? "COMPLETED" : "CANCELLED" } });
}
