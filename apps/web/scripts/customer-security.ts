import "dotenv/config";
import { prisma } from "../src/server/prisma/client";
import { customerAuth } from "../src/server/security/runtime";
import { CredentialVault } from "../src/server/security/credentialVault";
import { rotateSocialProgressKeys } from "../src/server/social/rotateProgressKeys";
import { rotateMetaPageCredentialKeys } from "../src/server/connections/metaPageCredentialStore";
import {
  migrateLegacyCredentials,
  pruneExpiredSecurityRecords,
  rotateCredentialKeys,
} from "../src/server/connections/credentialMaintenance";

async function main() {
  const command = process.argv[2];
  if (command === "provision") {
    if (process.stdin.isTTY)
      throw new Error(
        "Supply the customer JSON through standard input using a secure credential source.",
      );
    let input = "";
    for await (const chunk of process.stdin) {
      input += chunk;
      if (input.length > 8192) throw new Error("Customer input is too large.");
    }
    const value = JSON.parse(input);
    if (
      typeof value.email !== "string" ||
      typeof value.name !== "string" ||
      typeof value.password !== "string"
    )
      throw new Error("Invalid customer input.");
    const customer = await customerAuth().provisionCustomer(value);
    console.log(JSON.stringify({ customerId: customer.id }));
  } else if (command === "migrate-legacy") {
    console.log(
      JSON.stringify(
        await migrateLegacyCredentials(
          prisma,
          CredentialVault.fromEnvironment(),
        ),
      ),
    );
  } else if (command === "rotate-keys") {
    const vault = CredentialVault.fromEnvironment();
    const credentials = await rotateCredentialKeys(prisma, vault);
    const socialProgress = await rotateSocialProgressKeys(prisma, vault);
    const metaPages = await rotateMetaPageCredentialKeys(prisma, vault);
    console.log(JSON.stringify({ credentials, socialProgress, metaPages }));
  } else if (command === "prune") {
    await pruneExpiredSecurityRecords(prisma);
    console.log("Expired security records removed.");
  } else {
    throw new Error("Use provision, migrate-legacy, rotate-keys or prune.");
  }
}

main()
  .catch(() => {
    // Do not print raw database/provider/config exceptions or input containing secrets.
    console.error(
      "Security maintenance failed. Check configuration, input and database migration status.",
    );
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
