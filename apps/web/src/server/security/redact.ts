const sensitiveKey =
  /token|secret|password|authorization|cookie|credential|code[_-]?verifier|oauth.?state|signed[_-]?request|signature|^(state|code)$/i;

function redactParams(params: URLSearchParams) {
  let changed = false;
  for (const key of [...params.keys()]) {
    if (sensitiveKey.test(key)) {
      params.set(key, "[REDACTED]");
      changed = true;
    }
  }
  return changed;
}

export function redact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, child]) => [
        key,
        sensitiveKey.test(key) ? "[REDACTED]" : redact(child),
      ]),
    );
  }
  if (typeof value === "string") {
    let cleaned = value.replace(/\bBearer\s+[^\s"']+/gi, "Bearer [REDACTED]");
    if (/^https?:\/\//i.test(cleaned)) {
      try {
        const url = new URL(cleaned);
        url.username = "";
        url.password = "";
        redactParams(url.searchParams);
        cleaned = url.toString();
      } catch {
        return "[INVALID_URL]";
      }
    } else {
      // Downstream paths may be root-relative or lack a leading slash. Keep
      // their path/fragment intact and sanitize only sensitive query values.
      const queryStart = cleaned.indexOf("?");
      const fragmentStart = cleaned.indexOf("#");
      if (queryStart >= 0 && (fragmentStart < 0 || queryStart < fragmentStart)) {
        const queryEnd = fragmentStart < 0 ? cleaned.length : fragmentStart;
        const params = new URLSearchParams(
          cleaned.slice(queryStart + 1, queryEnd),
        );
        if (redactParams(params))
          cleaned = `${cleaned.slice(0, queryStart)}?${params}${cleaned.slice(queryEnd)}`;
      }
    }
    // Some OAuth responses carry credentials in the URL fragment rather than
    // the query. Preserve ordinary anchors and redact credential parameters.
    const fragmentStart = cleaned.indexOf("#");
    if (fragmentStart >= 0) {
      const params = new URLSearchParams(cleaned.slice(fragmentStart + 1));
      if (redactParams(params))
        cleaned = `${cleaned.slice(0, fragmentStart)}#${params}`;
    }
    return cleaned;
  }
  return value;
}
