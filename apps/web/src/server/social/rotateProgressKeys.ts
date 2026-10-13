import type { PrismaClient } from "../../generated/prisma/client";
import { CredentialVault } from "../security/credentialVault";

/** Operator maintenance only. Never report progress, session URLs, IDs or keys. */
export async function rotateSocialProgressKeys(db: PrismaClient, vault: CredentialVault) {
  const counts = { checked: 0, rotated: 0, skipped: 0, unavailable: 0 };
  let cursor: string | undefined;
  while (true) {
    const rows = await db.socialDeliveryProgress.findMany({ orderBy: { deliveryId: "asc" }, take: 100,
      ...(cursor ? { where: { deliveryId: { gt: cursor } } } : {}) });
    if (!rows.length) break;
    for (const row of rows) {
      counts.checked++;
      try {
        const context = `social-progress-v1:${row.deliveryId}`;
        const plaintext = vault.decrypt(row.encryptedState, context);
        if (row.encryptedState.split(".")[1] === vault.activeKeyId) { counts.skipped++; continue; }
        const changed = await db.socialDeliveryProgress.updateMany({ where: { deliveryId: row.deliveryId,
          version: row.version, encryptedState: row.encryptedState }, data: { encryptedState: vault.encrypt(plaintext, context), version: { increment: 1 } } });
        if (changed.count) counts.rotated++; else counts.skipped++;
      } catch { counts.unavailable++; }
    }
    cursor = rows[rows.length - 1].deliveryId;
  }
  return counts;
}
