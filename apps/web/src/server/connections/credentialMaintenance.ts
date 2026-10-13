import { randomUUID } from "node:crypto";
import type { PrismaClient } from "../../generated/prisma/client";
import { CredentialVault } from "../security/credentialVault";
import { credentialContext } from "./customerConnections";

export const legacyContext = (
  table: "user" | "platform",
  id: string,
  userId?: string,
) => JSON.stringify(["legacy-v1", table, userId ?? null, id]);

// Run after the additive SQL migration and before allowing application traffic.
// No scopes or provider identity can safely be inferred from legacy account rows.
export async function migrateLegacyCredentials(
  db: PrismaClient,
  vault: CredentialVault,
) {
  // Erase freed SQLite pages as plaintext values are replaced; run offline.
  await db.$executeRawUnsafe("PRAGMA secure_delete = ON");
  const result = await db.$transaction(
    async (tx) => {
      let encrypted = 0;
      for (const account of await tx.platformAccount.findMany()) {
        const context = legacyContext("platform", account.id);
        if (account.accessToken.startsWith("enc1."))
          vault.decrypt(account.accessToken, context);
        else {
          await tx.platformAccount.update({
            where: { id: account.id },
            data: { accessToken: vault.encrypt(account.accessToken, context) },
          });
          encrypted++;
        }
      }
      for (const account of await tx.platformUserAccount.findMany()) {
        const context = legacyContext("user", account.id, account.userId);
        const token = account.accessToken.startsWith("enc1.")
          ? vault.decrypt(account.accessToken, context)
          : account.accessToken;
        if (!account.accessToken.startsWith("enc1.")) {
          await tx.platformUserAccount.update({
            where: { id: account.id },
            data: { accessToken: vault.encrypt(token, context) },
          });
          encrypted++;
        }
        const unique = {
          userId: account.userId,
          provider: account.platform,
          providerUserId: `legacy-row:${account.id}`,
          capability: "ADS" as const,
        };
        if (
          await tx.providerAuthorization.findUnique({
            where: { userId_provider_providerUserId_capability: unique },
          })
        )
          continue;
        const id = randomUUID();
        await tx.providerAuthorization.create({
          data: {
            id,
            ...unique,
            scopes: [],
            status: "RECONNECT_REQUIRED",
            accessCiphertext: vault.encrypt(
              token,
              credentialContext(account.userId, id, "access"),
            ),
            destinations: {
              create: {
                externalId: account.externalId,
                kind: "AD_ACCOUNT",
                name: account.name,
                currency: account.currency,
                timezone: account.timezone,
                selected: false,
              },
            },
            events: { create: { action: "LEGACY_MIGRATED" } },
          },
        });
      }
      return { encrypted };
    },
    { timeout: 60_000 },
  );
  // Rebuild local SQLite pages so historical credential bytes are not retained.
  await db.$executeRawUnsafe("VACUUM");
  return result;
}

// The keyring must contain both old decryption keys and the new active key.
export async function rotateCredentialKeys(
  db: PrismaClient,
  vault: CredentialVault,
) {
  return db.$transaction(
    async (tx) => {
      let rotated = 0;
      for (const grant of await tx.providerAuthorization.findMany()) {
        const encrypt = (value: string | null, field: "access" | "refresh") =>
          value
            ? vault.encrypt(
                vault.decrypt(
                  value,
                  credentialContext(grant.userId, grant.id, field),
                ),
                credentialContext(grant.userId, grant.id, field),
              )
            : null;
        await tx.providerAuthorization.update({
          where: { id: grant.id },
          data: {
            accessCiphertext: encrypt(grant.accessCiphertext, "access"),
            refreshCiphertext: encrypt(grant.refreshCiphertext, "refresh"),
            credentialVersion: { increment: 1 },
          },
        });
        rotated++;
      }
      for (const attempt of await tx.oAuthAttempt.findMany({
        where: { verifierCiphertext: { not: null } },
      })) {
        const context = `oauth:${attempt.userId}:${attempt.id}`;
        await tx.oAuthAttempt.update({
          where: { id: attempt.id },
          data: {
            verifierCiphertext: vault.encrypt(
              vault.decrypt(attempt.verifierCiphertext!, context),
              context,
            ),
          },
        });
      }
      for (const account of await tx.platformUserAccount.findMany()) {
        const context = legacyContext("user", account.id, account.userId);
        await tx.platformUserAccount.update({
          where: { id: account.id },
          data: {
            accessToken: vault.encrypt(
              vault.decrypt(account.accessToken, context),
              context,
            ),
          },
        });
      }
      for (const account of await tx.platformAccount.findMany()) {
        const context = legacyContext("platform", account.id);
        await tx.platformAccount.update({
          where: { id: account.id },
          data: {
            accessToken: vault.encrypt(
              vault.decrypt(account.accessToken, context),
              context,
            ),
          },
        });
      }
      return { authorizations: rotated };
    },
    { timeout: 60_000 },
  );
}

export async function pruneExpiredSecurityRecords(
  db: PrismaClient,
  now = new Date(),
) {
  await db.$transaction(async (tx) => {
    await tx.customerSession.deleteMany({ where: { expiresAt: { lte: now } } });
    await tx.oAuthAttempt.deleteMany({ where: { expiresAt: { lte: now } } });
    await tx.loginAttempt.deleteMany({
      where: { windowStart: { lte: new Date(now.getTime() - 15 * 60 * 1000) } },
    });
  });
}
