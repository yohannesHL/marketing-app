import { createHash } from "node:crypto";
import { mockoonOrigin, providerJson, ProviderHttpError, record } from "./providerHttp";

export const GOOGLE_ADS_SCOPES = ["openid", "https://www.googleapis.com/auth/adwords"];
export const GOOGLE_ADS_API_VERSION = "v25";

export type GoogleAdsConfig = {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  apiVersion?: "v25";
  /** Server configuration only. Never populate this from a request. */
  mockoonBaseUrl?: string;
  mockoonEnabled?: boolean;
};
export type GoogleAdsGrant = {
  providerUserId: string;
  accessToken: string;
  refreshToken: string;
  scopes: string[];
  expiresAt: Date;
};
export type GoogleAdsContext = { customerId: string; loginCustomerId: string | null };
export type GoogleAdsDestination = {
  externalId: string;
  kind: "AD_ACCOUNT";
  name: string;
  currency: string;
  timezone: string;
  manager: boolean;
  status: string;
  contexts: { loginCustomerId: string | null }[];
  readiness: { canRead: true; canWrite: "UNKNOWN" };
};
export type GoogleAdsCampaign = {
  externalId: string;
  name: string;
  status: string;
  impressions: string;
  clicks: string;
  costMicros: string;
};

const CUSTOMER_QUERY = "SELECT customer.id, customer.descriptive_name, customer.currency_code, customer.time_zone, customer.manager, customer.status FROM customer LIMIT 1";
const HIERARCHY_QUERY = "SELECT customer_client.client_customer, customer_client.id, customer_client.level, customer_client.manager, customer_client.descriptive_name, customer_client.currency_code, customer_client.time_zone, customer_client.status FROM customer_client WHERE customer_client.level <= 1";
export const GOOGLE_ADS_SMOKE_QUERY = "SELECT campaign.id, campaign.name, campaign.status, metrics.impressions, metrics.clicks, metrics.cost_micros FROM campaign WHERE segments.date DURING LAST_7_DAYS LIMIT 10";

function malformed(): never {
  throw new ProviderHttpError("INVALID_PROVIDER_RESPONSE", 502, "Google returned an incomplete response.");
}
function customerId(value: unknown): string {
  if (typeof value !== "string" || !/^\d{1,20}$/.test(value))
    throw new ProviderHttpError("INVALID_ACCOUNT", 400, "Choose a valid Google Ads account.");
  return value;
}
function string(value: unknown): string { return typeof value === "string" ? value : malformed(); }
function metric(value: unknown): string {
  // Proto JSON may omit a zero-valued int64 field.
  if (value === undefined) return "0";
  if (typeof value !== "string" || !/^\d+$/.test(value)) malformed();
  return value;
}

export class GoogleAdsClient {
  private readonly mockOrigin?: string;
  private readonly adsBase: string;
  constructor(private readonly config: GoogleAdsConfig, private readonly clock = () => new Date()) {
    if (!config.clientId || !config.clientSecret || !config.redirectUri || (config.apiVersion && config.apiVersion !== "v25"))
      throw new ProviderHttpError("INVALID_CONFIG", 503, "Configure the Google OAuth client before connecting.");
    if (config.mockoonBaseUrl && config.mockoonEnabled !== true)
      throw new ProviderHttpError("INVALID_CONFIG", 503, "Enable the test-only Mockoon configuration explicitly.");
    this.mockOrigin = mockoonOrigin(config.mockoonBaseUrl);
    let callback: URL;
    try { callback = new URL(config.redirectUri); } catch { throw new ProviderHttpError("INVALID_CONFIG", 503, "The Google callback is invalid."); }
    if (callback.username || callback.password || callback.hash ||
      (callback.protocol !== "https:" && !(callback.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(callback.hostname))))
      throw new ProviderHttpError("INVALID_CONFIG", 503, "Use a secure registered Google callback.");
    this.adsBase = `${this.mockOrigin ?? "https://googleads.googleapis.com"}/v25`;
  }

  authorizationUrl(input: { state: string; codeChallenge: string }): string {
    if (!input.state || !/^[A-Za-z0-9_-]{43}$/.test(input.codeChallenge))
      throw new ProviderHttpError("INVALID_OAUTH_STATE", 400, "Restart the Google connection.");
    const url = new URL(`${this.mockOrigin ?? "https://accounts.google.com"}/o/oauth2/v2/auth`);
    url.search = new URLSearchParams({
      client_id: this.config.clientId, redirect_uri: this.config.redirectUri,
      response_type: "code", scope: GOOGLE_ADS_SCOPES.join(" "), state: input.state,
      access_type: "offline", prompt: "consent select_account",
      code_challenge: input.codeChallenge, code_challenge_method: "S256",
    }).toString();
    return url.toString();
  }

  async exchangeCode(input: { code: string; codeVerifier: string; previous?: { providerUserId: string; refreshToken: string } }): Promise<GoogleAdsGrant> {
    if (!input.code || !/^[A-Za-z0-9._~-]{43,128}$/.test(input.codeVerifier))
      throw new ProviderHttpError("INVALID_OAUTH_STATE", 400, "Restart the Google connection.");
    const tokens = await this.token({ grant_type: "authorization_code", code: input.code,
      code_verifier: input.codeVerifier, redirect_uri: this.config.redirectUri });
    return this.verifiedGrant(tokens, input.previous);
  }

  async refreshGrant(input: { providerUserId: string; refreshToken: string; scopes: string[] }): Promise<GoogleAdsGrant> {
    if (!input.refreshToken) throw new ProviderHttpError("RECONNECT_REQUIRED", 409, "Reconnect Google to restore offline access.");
    const tokens = await this.token({ grant_type: "refresh_token", refresh_token: input.refreshToken });
    return this.verifiedGrant(tokens, input, input.scopes);
  }

  private token(parameters: Record<string, string>) {
    return providerJson(`${this.mockOrigin ?? "https://oauth2.googleapis.com"}/token`, {
      method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ ...parameters, client_id: this.config.clientId, client_secret: this.config.clientSecret }),
    });
  }

  private async verifiedGrant(tokens: Record<string, unknown>, previous?: { providerUserId: string; refreshToken: string }, priorScopes?: string[]): Promise<GoogleAdsGrant> {
    const accessToken = string(tokens.access_token);
    if (!accessToken || typeof tokens.token_type !== "string" || tokens.token_type.toLowerCase() !== "bearer"
      || typeof tokens.expires_in !== "number" || !Number.isFinite(tokens.expires_in) || tokens.expires_in <= 0) malformed();
    const scopes = typeof tokens.scope === "string" ? tokens.scope.split(/\s+/).filter(Boolean) : priorScopes;
    if (!scopes || GOOGLE_ADS_SCOPES.some((scope) => !scopes.includes(scope)))
      throw new ProviderHttpError("MISSING_PERMISSION", 403, "Google Ads and identity permission are required. Reconnect and grant both permissions.");
    // The response is fetched directly from Google's fixed HTTPS endpoint with the exchanged token.
    // An unverified JWT payload or browser-provided identity is never used.
    const identity = await providerJson(`${this.mockOrigin ?? "https://openidconnect.googleapis.com/v1"}/userinfo`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    const providerUserId = string(identity.sub);
    if (!providerUserId || providerUserId.length > 255) malformed();
    if (previous && previous.providerUserId !== providerUserId)
      throw new ProviderHttpError("PROVIDER_IDENTITY_MISMATCH", 409, "This Google account differs from the account being reconnected.");
    const refreshToken = typeof tokens.refresh_token === "string" && tokens.refresh_token ? tokens.refresh_token : previous?.refreshToken;
    if (!refreshToken)
      throw new ProviderHttpError("RECONNECT_REQUIRED", 409, "Google did not grant offline access. Reconnect and approve permission.");
    return { providerUserId, accessToken, refreshToken, scopes: [...new Set(scopes)],
      expiresAt: new Date(this.clock().getTime() + tokens.expires_in * 1000) };
  }

  private async search(accessToken: string, context: GoogleAdsContext, query: string) {
    customerId(context.customerId);
    if (context.loginCustomerId !== null) customerId(context.loginCustomerId);
    const rows: Record<string, unknown>[] = [];
    let pageToken: string | undefined;
    const visited = new Set<string>();
    do {
      const response = await providerJson(`${this.adsBase}/customers/${context.customerId}/googleAds:search`, {
        method: "POST", headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json",
          ...(context.loginCustomerId ? { "login-customer-id": context.loginCustomerId } : {}) },
        body: JSON.stringify({ query, ...(pageToken ? { pageToken } : {}) }),
      });
      if (response.results !== undefined && !Array.isArray(response.results)) malformed();
      for (const row of (response.results ?? []) as unknown[]) rows.push(record(row));
      if (response.nextPageToken !== undefined && typeof response.nextPageToken !== "string") malformed();
      pageToken = response.nextPageToken as string | undefined;
      if (pageToken) {
        if (visited.has(pageToken) || visited.size >= 1000) malformed();
        visited.add(pageToken);
      }
    } while (pageToken);
    return rows;
  }

  private destination(row: Record<string, unknown>, loginCustomerId: string | null): GoogleAdsDestination {
    const id = customerId(row.id);
    if ((row.manager !== undefined && typeof row.manager !== "boolean") || typeof row.currencyCode !== "string" || typeof row.timeZone !== "string" || typeof row.status !== "string") malformed();
    return { externalId: id, kind: "AD_ACCOUNT", name: typeof row.descriptiveName === "string" ? row.descriptiveName : id,
      currency: row.currencyCode, timezone: row.timeZone, manager: row.manager === true, status: row.status,
      contexts: [{ loginCustomerId }], readiness: { canRead: true, canWrite: "UNKNOWN" } };
  }

  async discoverAccounts(accessToken: string): Promise<GoogleAdsDestination[]> {
    const direct = await providerJson(`${this.adsBase}/customers:listAccessibleCustomers`, { headers: { Authorization: `Bearer ${accessToken}` } });
    if (direct.resourceNames !== undefined && !Array.isArray(direct.resourceNames)) malformed();
    const accounts = new Map<string, GoogleAdsDestination>();
    const add = (destination: GoogleAdsDestination) => {
      const existing = accounts.get(destination.externalId);
      if (!existing) accounts.set(destination.externalId, destination);
      else for (const context of destination.contexts)
        if (!existing.contexts.some((c) => c.loginCustomerId === context.loginCustomerId)) existing.contexts.push(context);
    };
    const roots = new Set(((direct.resourceNames ?? []) as unknown[]).map((name: unknown) => {
      if (typeof name !== "string" || !/^customers\/\d{1,20}$/.test(name)) malformed();
      return name.slice("customers/".length);
    }));
    for (const root of roots) {
      const data = await this.search(accessToken, { customerId: root, loginCustomerId: null }, CUSTOMER_QUERY);
      if (data.length !== 1) malformed();
      const destination = this.destination(record(data[0].customer), null);
      if (destination.externalId !== root) malformed();
      add(destination);
      if (!destination.manager) continue;
      const queue = [root];
      const visited = new Set<string>();
      while (queue.length) {
        const manager = queue.shift()!;
        if (visited.has(manager)) continue;
        visited.add(manager);
        if (visited.size > 1000) malformed();
        const children = await this.search(accessToken, { customerId: manager, loginCustomerId: root }, HIERARCHY_QUERY);
        for (const row of children) {
          const child = record(row.customerClient);
          const level = Number(child.level);
          if (level === 0) continue;
          if (level !== 1) malformed();
          const item = this.destination(child, root);
          if (child.clientCustomer !== `customers/${item.externalId}`) malformed();
          add(item);
          if (item.manager) queue.push(item.externalId);
        }
      }
    }
    return [...accounts.values()];
  }

  async verifyAccount(accessToken: string, context: GoogleAdsContext): Promise<GoogleAdsDestination> {
    customerId(context.customerId);
    if (context.loginCustomerId !== null) customerId(context.loginCustomerId);
    const accounts = await this.discoverAccounts(accessToken);
    const permitted = accounts.find((account) => account.externalId === context.customerId && !account.manager
      && account.contexts.some((candidate) => candidate.loginCustomerId === context.loginCustomerId));
    if (!permitted)
      throw new ProviderHttpError("ACCOUNT_NOT_ACCESSIBLE", 403, "Choose an advertiser account returned by Google for this connection.");
    const rows = await this.search(accessToken, context, CUSTOMER_QUERY);
    if (rows.length !== 1) malformed();
    const verified = this.destination(record(rows[0].customer), context.loginCustomerId);
    if (verified.externalId !== context.customerId || verified.manager) malformed();
    return verified;
  }

  async readCampaigns(accessToken: string, context: GoogleAdsContext): Promise<GoogleAdsCampaign[]> {
    const rows = await this.search(accessToken, context, GOOGLE_ADS_SMOKE_QUERY);
    return rows.map((row) => {
      const campaign = record(row.campaign), metrics = record(row.metrics);
      return { externalId: customerId(campaign.id), name: string(campaign.name), status: string(campaign.status),
        impressions: metric(metrics.impressions), clicks: metric(metrics.clicks), costMicros: metric(metrics.costMicros) };
    });
  }
}

export function googlePkceChallenge(verifier: string) {
  return createHash("sha256").update(verifier).digest("base64url");
}
