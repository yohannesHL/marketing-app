/** Opt-in customer read check. No provider credentials, campaign writes or retries. */
function requireValue(value: unknown): asserts value {
  if (!value) throw new Error("Invalid read-only pilot input or response.");
}

function object(value: unknown): Record<string, unknown> {
  requireValue(value && typeof value === "object" && !Array.isArray(value));
  return value as Record<string, unknown>;
}

function destinationIds(value: unknown, maximum: number): string[] {
  requireValue(Array.isArray(value) && value.length > 0 && value.length <= maximum);
  requireValue(value.every((id) => typeof id === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(id)));
  requireValue(new Set(value).size === value.length);
  return value as string[];
}

function configuration() {
  let enabled = false;
  let mock = false;
  const selected: string[] = [];
  const args = process.argv.slice(2);
  for (let index = 0; index < args.length; index++) {
    const argument = args[index];
    if (argument === "--run-read-only" && !enabled) enabled = true;
    else if (argument === "--mock" && !mock) mock = true;
    else if (argument === "--destination") selected.push(args[++index]);
    else requireValue(false);
  }
  requireValue(enabled);
  const ids = destinationIds(selected, 25);
  const allowlist = destinationIds(JSON.parse(process.env.ADS_PILOT_ALLOWLIST ?? "null"), 1000);
  requireValue(ids.every((id) => allowlist.includes(id)));
  const url = new URL(process.env.APP_ORIGIN ?? "");
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  requireValue(!url.username && !url.password && url.pathname === "/" && !url.search && !url.hash);
  requireValue(url.protocol === "https:" || (mock && loopback && url.protocol === "http:"));
  return { origin: url.origin, ids, mode: mock ? "mock" : "live" };
}

async function credentials() {
  let value: Record<string, unknown>;
  if (process.env.ADS_PILOT_EMAIL !== undefined || process.env.ADS_PILOT_PASSWORD !== undefined) {
    value = { email: process.env.ADS_PILOT_EMAIL, password: process.env.ADS_PILOT_PASSWORD };
  } else {
    requireValue(!process.stdin.isTTY);
    const chunks: Buffer[] = [];
    let length = 0;
    for await (const chunk of process.stdin) {
      const bytes = Buffer.from(chunk);
      length += bytes.length;
      requireValue(length <= 8192);
      chunks.push(bytes);
    }
    value = object(JSON.parse(Buffer.concat(chunks).toString("utf8")));
  }
  requireValue(Object.keys(value).every((key) => ["email", "password"].includes(key)));
  requireValue(typeof value.email === "string" && value.email.length > 0 && value.email.length <= 320);
  requireValue(typeof value.password === "string" && value.password.length > 0 && value.password.length <= 256);
  return { email: value.email, password: value.password };
}

async function responseJson(response: Response) {
  requireValue(response.ok && response.headers.get("content-type")?.toLowerCase().startsWith("application/json"));
  requireValue(response.body);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    length += value.byteLength;
    if (length > 1024 * 1024) {
      await reader.cancel();
      requireValue(false);
    }
    chunks.push(value);
  }
  return object(JSON.parse(Buffer.concat(chunks).toString("utf8")));
}

async function main() {
  const { origin, ids, mode } = configuration();
  const login = await fetch(`${origin}/api/auth/login`, {
    method: "POST", headers: { Origin: origin, "Content-Type": "application/json" },
    body: JSON.stringify(await credentials()), redirect: "error", signal: AbortSignal.timeout(15_000),
  });
  await login.body?.cancel();
  requireValue(login.ok);
  const cookieName = origin.startsWith("https:") ? "__Host-launchpad_session" : "launchpad_session";
  const cookie = login.headers.get("set-cookie")?.split(";")[0];
  requireValue(cookie && new RegExp(`^${cookieName}=[A-Za-z0-9_-]{16,256}$`).test(cookie));
  const response = await fetch(`${origin}/api/ads/readiness`, {
    method: "POST", headers: { Origin: origin, "Content-Type": "application/json", Cookie: cookie },
    body: JSON.stringify({ destinationIds: ids }), redirect: "error", signal: AbortSignal.timeout(15_000),
  });
  const result = await responseJson(response);
  requireValue(result.mode === mode && result.writesEnabled === false);
  requireValue(typeof result.success === "boolean" && typeof result.partial === "boolean");
  requireValue(Array.isArray(result.outcomes) && result.outcomes.length === ids.length);
  const seen = new Set<string>();
  const outcomes = result.outcomes.map((value: unknown) => {
    const row = object(value);
    requireValue(typeof row.destinationId === "string" && ids.includes(row.destinationId) && !seen.has(row.destinationId));
    seen.add(row.destinationId);
    requireValue(row.provider === "GOOGLE" || row.provider === "META");
    requireValue(typeof row.success === "boolean" && typeof row.canRead === "boolean" && row.canWrite === "DISABLED");
    requireValue(!row.success || row.canRead);
    return { destinationId: row.destinationId, provider: row.provider, success: row.success,
      canRead: row.canRead, canWrite: "DISABLED" };
  });
  const success = outcomes.every((row) => row.success);
  const partial = !success && outcomes.some((row) => row.success);
  requireValue(result.success === success && result.partial === partial);
  // Never print account names, external IDs, campaigns, provider error text,
  // customer identity or the temporary session cookie.
  console.log(JSON.stringify({ mode, writesEnabled: false, success, partial, outcomes }));
  if (!success) process.exitCode = 1;
}

main().catch(() => {
  console.error("Read-only pilot failed. Verify configuration, credentials, selected destinations and provider access.");
  process.exitCode = 1;
});
