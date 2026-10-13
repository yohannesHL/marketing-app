import { createHmac } from "node:crypto";
import type { ProviderGrant } from "../connections/customerConnections";

export const META_ADS_SCOPES = [
  "ads_management", "pages_read_engagement", "pages_show_list",
] as const;

export class MetaProviderError extends Error {
  constructor(
    public readonly code: string,
    public readonly status: number,
    public readonly retryable = false,
    public readonly providerCode?: number,
  ) {
    super(code === "MISSING_PERMISSION"
      ? "Reconnect Meta and grant the required permissions."
      : code === "RECONNECT_REQUIRED"
        ? "Reconnect the Meta account to continue."
        : code === "ACCOUNT_UNAVAILABLE"
          ? "This ad account cannot manage campaigns."
          : "The Meta request could not be completed.");
    this.name = "MetaProviderError";
  }
}

export type MetaAdsConfig = {
  appId: string;
  appSecret: string;
  configId: string;
  redirectUri: string;
  graphVersion?: string;
  marketingVersion?: string;
  /** Explicit isolated HTTP fixture origin; never populated from a request. */
  testBaseUrl?: string;
  now?: () => Date;
};
export type VerifiedMetaGrant = ProviderGrant & {
  displayName: string;
  dataAccessExpiresAt: Date | null;
  tokenType: "USER";
};
export type MetaAdAccount = {
  externalId: string;
  graphId: string;
  name: string;
  currency: string;
  timezone: string;
  accountStatus: number;
  userTasks: string[];
  canManage: boolean;
};
export type MetaCampaignInput = {
  name: string;
  objective?: "OUTCOME_TRAFFIC" | "OUTCOME_AWARENESS" | "OUTCOME_ENGAGEMENT" |
    "OUTCOME_LEADS" | "OUTCOME_SALES" | "OUTCOME_APP_PROMOTION";
  specialAdCategories?: string[];
};
export type MetaCampaign = {
  id: string;
  accountId: string;
  name: string;
  status: string;
  effectiveStatus: string;
  objective: string;
  specialAdCategories: string[];
};
type Json = Record<string, unknown>;
const ACCOUNT_FIELDS = "id,account_id,name,account_status,currency,timezone_name,user_tasks";
const CAMPAIGN_FIELDS = "id,account_id,name,status,effective_status,objective,special_ad_categories";
const invalid = () => { throw new MetaProviderError("INVALID_PROVIDER_RESPONSE", 502); };
function object(value: unknown): Json {
  if (!value || typeof value !== "object" || Array.isArray(value)) return invalid();
  return value as Json;
}
function text(value: unknown, max = 512): string {
  if (typeof value !== "string" || !value || value.length > max) return invalid();
  return value;
}
function stringList(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > 100 ||
      value.some((v) => typeof v !== "string" || !v || v.length > 512)) return invalid();
  return [...new Set(value as string[])];
}
function numericId(value: unknown): string {
  const result = text(value, 64);
  if (!/^\d+$/.test(result)) return invalid();
  return result;
}
function accountId(value: string): string {
  return numericId(value.replace(/^act_/, ""));
}
function unixExpiry(value: unknown): Date | null {
  if (value === 0) return null;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) return invalid();
  const date = new Date(value * 1000);
  if (!Number.isFinite(date.getTime())) return invalid();
  return date;
}

/** Server-only provider client. Customer/session and operation gates live above it. */
export class MetaAdsClient {
  readonly scopes = [...META_ADS_SCOPES];
  readonly pkce = false;
  readonly redirectUri: string;
  readonly graphVersion: string;
  readonly marketingVersion: string;
  #appId: string;
  #appSecret: string;
  #configId: string;
  #origin: string;
  #loginOrigin: string;
  #now: () => Date;

  constructor(config: MetaAdsConfig) {
    this.#appId = numericId(config.appId);
    this.#configId = numericId(config.configId);
    this.#appSecret = text(config.appSecret, 32768);
    this.graphVersion = config.graphVersion ?? "v26.0";
    this.marketingVersion = config.marketingVersion ?? "v26.0";
    if (!/^v(21|22|23|24|25|26)\.0$/.test(this.graphVersion) ||
        !/^v(25|26)\.0$/.test(this.marketingVersion)) {
      throw new MetaProviderError("INVALID_PROVIDER_CONFIG", 500);
    }
    const redirect = new URL(config.redirectUri);
    const isLoopback = (host: string) => ["localhost", "127.0.0.1", "[::1]"].includes(host);
    if (redirect.username || redirect.password || redirect.search || redirect.hash ||
        (redirect.protocol !== "https:" && !(redirect.protocol === "http:" && isLoopback(redirect.hostname)))) {
      throw new MetaProviderError("INVALID_PROVIDER_CONFIG", 500);
    }
    this.redirectUri = redirect.href;
    this.#origin = "https://graph.facebook.com";
    this.#loginOrigin = "https://www.facebook.com";
    if (config.testBaseUrl) {
      const test = new URL(config.testBaseUrl);
      if (test.protocol !== "http:" || !isLoopback(test.hostname) || test.username ||
          test.password || test.pathname !== "/" || test.search || test.hash) {
        throw new MetaProviderError("INVALID_PROVIDER_CONFIG", 500);
      }
      this.#origin = test.origin;
      this.#loginOrigin = test.origin;
    }
    this.#now = config.now ?? (() => new Date());
  }

  authorizationUrl(state: string): string {
    const url = new URL(`/${this.graphVersion}/dialog/oauth`, this.#loginOrigin);
    url.search = new URLSearchParams({
      client_id: this.#appId, config_id: this.#configId,
      redirect_uri: this.redirectUri, state: text(state, 1024),
      response_type: "code", override_default_response_type: "true",
    }).toString();
    return url.href;
  }

  async exchangeCode(code: string, expectedProviderUserId?: string): Promise<VerifiedMetaGrant> {
    const short = await this.#request(`${this.graphVersion}/oauth/access_token`, undefined, {
      client_id: this.#appId, client_secret: this.#appSecret,
      redirect_uri: this.redirectUri, code: text(code, 32768),
    });
    const long = await this.#request(`${this.graphVersion}/oauth/access_token`, undefined, {
      grant_type: "fb_exchange_token", client_id: this.#appId,
      client_secret: this.#appSecret, fb_exchange_token: text(short.access_token, 32768),
    });
    return this.verifyToken(text(long.access_token, 32768), {
      expiresIn: long.expires_in, expectedProviderUserId,
    });
  }

  async verifyToken(accessToken: string, options: {
    expiresIn?: unknown; expectedProviderUserId?: string;
  } = {}): Promise<VerifiedMetaGrant> {
    const token = text(accessToken, 32768);
    const debug = object((await this.#request(`${this.graphVersion}/debug_token`,
      `${this.#appId}|${this.#appSecret}`, { input_token: token })).data);
    const debugAppId = typeof debug.app_id === "string" ? debug.app_id :
      typeof debug.app_id === "number" && Number.isSafeInteger(debug.app_id) ? String(debug.app_id) : null;
    if (debug.is_valid !== true || debugAppId !== this.#appId || debug.type !== "USER") {
      throw new MetaProviderError("RECONNECT_REQUIRED", 401);
    }
    const subject = numericId(debug.user_id);
    if (options.expectedProviderUserId && subject !== options.expectedProviderUserId) {
      throw new MetaProviderError("SUBJECT_MISMATCH", 403);
    }
    const scopes = stringList(debug.scopes);
    if (this.scopes.some((scope) => !scopes.includes(scope))) {
      throw new MetaProviderError("MISSING_PERMISSION", 403);
    }
    let expiresAt = unixExpiry(debug.expires_at);
    const dataAccessExpiresAt = debug.data_access_expires_at === undefined
      ? null : unixExpiry(debug.data_access_expires_at);
    if (options.expiresIn !== undefined) {
      if (typeof options.expiresIn !== "number" || !Number.isSafeInteger(options.expiresIn) ||
          options.expiresIn <= 0) return invalid();
      const responseExpiry = new Date(this.#now().getTime() + options.expiresIn * 1000);
      if (!Number.isFinite(responseExpiry.getTime())) return invalid();
      if (!expiresAt || responseExpiry < expiresAt) expiresAt = responseExpiry;
    }
    if (dataAccessExpiresAt && (!expiresAt || dataAccessExpiresAt < expiresAt)) {
      expiresAt = dataAccessExpiresAt;
    }
    if (expiresAt && expiresAt <= this.#now()) throw new MetaProviderError("RECONNECT_REQUIRED", 401);
    const me = await this.#request(`${this.graphVersion}/me`, token, { fields: "id,name" });
    if (numericId(me.id) !== subject) throw new MetaProviderError("SUBJECT_MISMATCH", 403);
    return {
      providerUserId: subject, externalGrantId: subject, accessToken: token,
      scopes, expiresAt, dataAccessExpiresAt, displayName: text(me.name), tokenType: "USER",
    };
  }

  async discoverAccounts(accessToken: string): Promise<MetaAdAccount[]> {
    const accounts = new Map<string, MetaAdAccount>();
    const seen = new Set<string>();
    let after: string | undefined;
    for (let page = 0; page < 100; page++) {
      const result = await this.#request(`${this.marketingVersion}/me/adaccounts`, accessToken, {
        fields: ACCOUNT_FIELDS, limit: "100", ...(after ? { after } : {}),
      });
      if (!Array.isArray(result.data)) return invalid();
      for (const data of result.data) {
        const account = this.#account(object(data));
        accounts.set(account.externalId, account);
      }
      if (result.paging === undefined) return [...accounts.values()];
      const paging = object(result.paging);
      if (paging.next === undefined) return [...accounts.values()];
      // Never follow a provider-supplied URL with credentials. Validate its boundary,
      // then reconstruct the same edge with our own bearer token and only its cursor.
      let next: URL;
      try { next = new URL(text(paging.next, 32768), this.#origin); }
      catch { return invalid(); }
      if (next.origin !== this.#origin || next.username || next.password || next.hash ||
          next.pathname !== `/${this.marketingVersion}/me/adaccounts`) return invalid();
      after = next.searchParams.get("after") ?? undefined;
      if (!after || after.length > 4096 || seen.has(after)) return invalid();
      seen.add(after);
    }
    return invalid();
  }

  async readAccount(accessToken: string, externalId: string): Promise<MetaAdAccount> {
    const id = accountId(externalId);
    const account = this.#account(await this.#request(`${this.marketingVersion}/act_${id}`,
      accessToken, { fields: ACCOUNT_FIELDS }));
    if (account.externalId !== id) return invalid();
    return account;
  }

  async validatePausedCampaign(accessToken: string, externalId: string, input: MetaCampaignInput) {
    await this.#writable(accessToken, externalId);
    const result = await this.#request(`${this.marketingVersion}/act_${accountId(externalId)}/campaigns`,
      accessToken, {}, "POST", { ...this.#campaignBody(input), execution_options: '["validate_only"]' });
    if (result.success !== true) return invalid();
    return { success: true as const };
  }

  async createPausedCampaign(accessToken: string, externalId: string, input: MetaCampaignInput) {
    await this.#writable(accessToken, externalId);
    const result = await this.#request(`${this.marketingVersion}/act_${accountId(externalId)}/campaigns`,
      accessToken, {}, "POST", this.#campaignBody(input));
    return { id: numericId(result.id) };
  }

  async readCampaign(accessToken: string, campaignId: string, expectedAccountId: string): Promise<MetaCampaign> {
    const result = await this.#request(`${this.marketingVersion}/${numericId(campaignId)}`,
      accessToken, { fields: CAMPAIGN_FIELDS });
    if (numericId(result.id) !== campaignId || numericId(result.account_id) !== accountId(expectedAccountId)) {
      return invalid();
    }
    return { id: campaignId, accountId: accountId(expectedAccountId), name: text(result.name),
      status: text(result.status), effectiveStatus: text(result.effective_status),
      objective: text(result.objective), specialAdCategories: stringList(result.special_ad_categories) };
  }

  async removeCampaign(accessToken: string, campaignId: string, expectedAccountId: string) {
    const campaign = await this.readCampaign(accessToken, campaignId, expectedAccountId);
    if (campaign.status !== "PAUSED") throw new MetaProviderError("CAMPAIGN_NOT_PAUSED", 409);
    await this.#writable(accessToken, expectedAccountId);
    const result = await this.#request(`${this.marketingVersion}/${numericId(campaignId)}`,
      accessToken, {}, "DELETE");
    if (result.success !== true) return invalid();
    return { success: true as const };
  }

  #campaignBody(input: MetaCampaignInput): Record<string, string> {
    const name = text(input.name, 255);
    const objective = input.objective ?? "OUTCOME_TRAFFIC";
    if (!["OUTCOME_TRAFFIC", "OUTCOME_AWARENESS", "OUTCOME_ENGAGEMENT", "OUTCOME_LEADS",
      "OUTCOME_SALES", "OUTCOME_APP_PROMOTION"].includes(objective)) return invalid();
    const categories = stringList(input.specialAdCategories ?? []);
    if (categories.some((v) => !["NONE", "EMPLOYMENT", "HOUSING", "CREDIT",
      "ISSUES_ELECTIONS_POLITICS", "ONLINE_GAMBLING_AND_GAMING", "FINANCIAL_PRODUCTS_SERVICES"].includes(v))) return invalid();
    return { name, objective, status: "PAUSED", special_ad_categories: JSON.stringify(categories),
      is_adset_budget_sharing_enabled: "0" };
  }

  async #writable(token: string, id: string) {
    if (!(await this.readAccount(token, id)).canManage) {
      throw new MetaProviderError("ACCOUNT_UNAVAILABLE", 403);
    }
  }

  #account(data: Json): MetaAdAccount {
    const id = numericId(data.account_id);
    if (text(data.id) !== `act_${id}` || typeof data.account_status !== "number" ||
        !Number.isSafeInteger(data.account_status)) return invalid();
    const tasks = stringList(data.user_tasks ?? []);
    return { externalId: id, graphId: `act_${id}`, name: text(data.name),
      currency: text(data.currency, 10), timezone: text(data.timezone_name),
      accountStatus: data.account_status, userTasks: tasks,
      canManage: data.account_status === 1 && (tasks.includes("ADVERTISE") || tasks.includes("MANAGE")) };
  }

  async #request(path: string, accessToken?: string, params: Record<string, string> = {},
    method = "GET", body?: Record<string, string>): Promise<Json> {
    const url = new URL(`/${path}`, this.#origin);
    const query = { ...params };
    const headers: Record<string, string> = { accept: "application/json" };
    if (accessToken) {
      headers.authorization = `Bearer ${text(accessToken, 32768)}`;
      query.appsecret_proof = createHmac("sha256", this.#appSecret).update(accessToken).digest("hex");
    }
    url.search = new URLSearchParams(query).toString();
    if (body) headers["content-type"] = "application/x-www-form-urlencoded";
    let response: Response;
    try {
      response = await fetch(url, { method, headers, redirect: "error",
        signal: AbortSignal.timeout(10_000), ...(body ? { body: new URLSearchParams(body) } : {}) });
    } catch {
      throw new MetaProviderError("PROVIDER_UNAVAILABLE", 502, method === "GET");
    }
    let data: Json;
    try {
      const raw = await response.text();
      if (raw.length > 1024 * 1024) return invalid();
      data = object(JSON.parse(raw));
    } catch { return invalid(); }
    if (!response.ok || data.error) {
      const error = data.error && typeof data.error === "object" ? data.error as Json : {};
      const code = typeof error.code === "number" && Number.isSafeInteger(error.code) ? error.code : undefined;
      const reconnect = code === 190;
      const missing = code === 10 || code === 200;
      const retryable = method === "GET" && (response.status === 429 || response.status >= 500 ||
        error.is_transient === true || [4, 17, 32, 613, 80004].includes(code ?? -1));
      throw new MetaProviderError(reconnect ? "RECONNECT_REQUIRED" : missing ? "MISSING_PERMISSION" :
        "PROVIDER_REJECTED", reconnect ? 401 : missing ? 403 : 502, retryable, code);
    }
    return data;
  }
}
