import { resolveAuthStorageStatePath, resolveTestEnv } from "./env";

export type AuthSession = {
  storageStatePath: string;
  strategy: "anonymous";
  environment: string;
};

export function buildAnonymousSession(): AuthSession {
  return {
    storageStatePath: resolveAuthStorageStatePath(),
    strategy: "anonymous",
    environment: resolveTestEnv(),
  };
}
