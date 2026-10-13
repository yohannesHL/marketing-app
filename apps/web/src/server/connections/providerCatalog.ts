import { privateJson, securityResponse } from "../security/errors";

/** Configuration readiness is separate from provider approval or advertising readiness. */
export function providerCatalog(env: NodeJS.ProcessEnv, configure: Record<"GOOGLE" | "META", () => unknown>,
  configureSocial: Partial<Record<"YOUTUBE" | "FACEBOOK" | "INSTAGRAM" | "TIKTOK" | "LINKEDIN" | "X", () => unknown>> = {}) {
  const mode = env.CONNECTION_MODE === "mock" || env.CONNECTION_MODE === "live"
    ? env.CONNECTION_MODE : "disabled";
  const paid = (["GOOGLE", "META"] as const).map((provider) => {
    let enabled = false;
    let reason = "Customer connections are disabled in this environment.";
    if (mode !== "disabled") {
      try { configure[provider](); enabled = true; }
      catch { reason = "Provider configuration needs attention. Contact your workspace administrator."; }
    }
    return { provider, enabled, ...(enabled ? {} : { reason }), liveWritesEnabled: false };
  });
  return { mode, paid, social: [
    { provider: "YOUTUBE", label: "YouTube Shorts", enabled: false },
    { provider: "FACEBOOK", label: "Facebook Pages", enabled: false },
    { provider: "INSTAGRAM", label: "Instagram", enabled: false },
    { provider: "TIKTOK", label: "TikTok", enabled: false },
    { provider: "LINKEDIN", label: "LinkedIn", enabled: false },
    { provider: "X", label: "X", enabled: false },
  ].map((platform) => {
    const configure = configureSocial[platform.provider as keyof typeof configureSocial];
    if (mode !== "disabled" && configure) { try { const readiness = configure(); return { ...platform, enabled: true,
      ...(platform.provider === "X" && readiness && typeof readiness === "object" && "connectionReadCostMicros" in readiness &&
        Number.isSafeInteger(readiness.connectionReadCostMicros) && Number(readiness.connectionReadCostMicros) >= 0
        ? { connectionReadCostMicros: Number(readiness.connectionReadCostMicros) } : {}), ...(platform.provider === "TIKTOK" ? { audited: env.TIKTOK_APP_AUDITED === "true" } : {}) }; } catch {} }
    return platform;
  }) };
}

export async function handleProviderCatalog(request: Request) {
  try {
    const { customerAuth } = await import("../security/runtime");
    const principal = await customerAuth().requireSession(request);
    const { googleConnectionService } = await import("./googleRuntime");
    const { metaConnectionService } = await import("./metaRuntime");
    const { youtubeConnectionService } = await import("./youtubeRuntime");
    const { metaPublishingConnectionService } = await import("./metaPublishingRuntime");
    const { tiktokConnectionService } = await import("./tiktokRuntime");
    const { linkedinConnectionService } = await import("./linkedinRuntime");
    const { xConnectionService, xApiBudgetPolicies } = await import("./xRuntime");
    const { xPriceSchedule } = await import("../providers/xPricing");
    const { fail } = await import("../security/errors");
    const xReady = () => {
      xConnectionService(); xPriceSchedule();
      const policy = xApiBudgetPolicies().find(item => item.ownerId === principal.userId && item.mode === process.env.CONNECTION_MODE);
      if (!policy || policy.operationCeilings.USER_READ === undefined) fail("API_COST_APPROVAL_REQUIRED", 503, "Configure this customer's X API allowance.");
      return { connectionReadCostMicros: policy!.operationCeilings.USER_READ };
    };
    return privateJson(providerCatalog(process.env, { GOOGLE: googleConnectionService, META: metaConnectionService }, {
      YOUTUBE: youtubeConnectionService, FACEBOOK: metaPublishingConnectionService, INSTAGRAM: metaPublishingConnectionService, TIKTOK: tiktokConnectionService, LINKEDIN: linkedinConnectionService, X: xReady,
    }));
  } catch (error) { return securityResponse(error); }
}
