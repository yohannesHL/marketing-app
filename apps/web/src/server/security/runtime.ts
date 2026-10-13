import { CustomerAuth } from "../auth/customerAuth";
import { CustomerConnections } from "../connections/customerConnections";
import { prisma } from "../prisma/client";
import { CredentialVault } from "./credentialVault";
import { createCustomerApi } from "./customerApi";
import { fail, securityResponse } from "./errors";

export function customerAuth() {
  if (!process.env.APP_ORIGIN)
    fail(
      "INVALID_CONFIG",
      503,
      "Configure APP_ORIGIN before enabling customer access.",
    );
  return new CustomerAuth(prisma, { origin: process.env.APP_ORIGIN });
}

export function customerConnections() {
  return new CustomerConnections(
    prisma,
    customerAuth(),
    CredentialVault.fromEnvironment(),
  );
}

export async function handleCustomerApi(request: Request) {
  try {
    return await createCustomerApi(
      customerAuth(),
      customerConnections(),
    )(request);
  } catch (error) {
    return securityResponse(error);
  }
}
