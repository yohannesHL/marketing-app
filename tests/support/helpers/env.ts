export const DEFAULT_BASE_URL = "http://127.0.0.1:3000";
export const DEFAULT_API_URL = `${DEFAULT_BASE_URL}/api`;

export function requireEnv(name: string): string {
  const value = process.env[name];

  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }

  return value;
}

export function resolveBaseUrl(): string {
  return process.env.BASE_URL ?? DEFAULT_BASE_URL;
}

export function resolveApiUrl(): string {
  return process.env.API_URL ?? DEFAULT_API_URL;
}

export function resolveStorybookBaseUrl(): string {
  return process.env.STORYBOOK_BASE_URL ?? "http://127.0.0.1:6006";
}

export function resolveTestEnv(): string {
  return process.env.TEST_ENV ?? "local";
}

export function resolveAuthStorageStatePath(): string {
  return process.env.AUTH_STORAGE_STATE ?? "tests/.auth/anonymous.json";
}
