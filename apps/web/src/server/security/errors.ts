export class SecurityError extends Error {
  constructor(
    public readonly code: string,
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "SecurityError";
  }
}

export function fail(code: string, status: number, message: string): never {
  throw new SecurityError(code, status, message);
}

export function securityResponse(error: unknown): Response {
  if (error instanceof SecurityError) {
    return privateJson(
      { code: error.code, message: error.message },
      error.status,
    );
  }
  // Provider exceptions, database errors and cryptographic errors may contain secrets.
  return privateJson(
    { code: "INTERNAL_ERROR", message: "The request could not be completed." },
    500,
  );
}

export function privateJson(
  body: unknown,
  status = 200,
  headers?: HeadersInit,
): Response {
  const response = Response.json(body, { status, headers });
  response.headers.set("Cache-Control", "no-store");
  return response;
}

export async function readBody(
  request: Request,
): Promise<Record<string, unknown>> {
  if (
    !request.headers
      .get("content-type")
      ?.toLowerCase()
      .startsWith("application/json")
  ) {
    fail("INVALID_BODY", 400, "A JSON request body is required.");
  }
  const reader = request.body?.getReader();
  if (!reader) fail("INVALID_BODY", 400, "A JSON request body is required.");
  const chunks: Uint8Array[] = [];
  let length = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    length += value.byteLength;
    if (length > 32_768) {
      await reader.cancel();
      fail("INVALID_BODY", 413, "The request body is too large.");
    }
    chunks.push(value);
  }
  try {
    const body: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!body || typeof body !== "object" || Array.isArray(body))
      throw new Error();
    return body as Record<string, unknown>;
  } catch {
    fail("INVALID_BODY", 400, "A valid JSON object is required.");
  }
}
