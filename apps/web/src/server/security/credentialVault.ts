import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { fail } from "./errors";

export class CredentialVault {
  private readonly keys = new Map<string, Buffer>();
  constructor(
    keys: Record<string, string>,
    readonly activeKeyId: string,
  ) {
    for (const [id, value] of Object.entries(keys)) {
      const key = Buffer.from(value, "base64");
      if (
        !/^[a-zA-Z0-9_-]{1,40}$/.test(id) ||
        key.length !== 32 ||
        key.toString("base64") !== value
      ) {
        fail(
          "INVALID_KEY_CONFIG",
          503,
          "Credential keys must be canonical base64 encodings of 32 random bytes.",
        );
      }
      this.keys.set(id, key);
    }
    if (!this.keys.has(activeKeyId))
      fail(
        "INVALID_KEY_CONFIG",
        503,
        "The active credential key is not configured.",
      );
  }

  static fromEnvironment() {
    try {
      const value: unknown = JSON.parse(
        process.env.CONNECTION_TOKEN_KEYS ?? "{}",
      );
      if (
        !value ||
        typeof value !== "object" ||
        Array.isArray(value) ||
        Object.values(value).some((key) => typeof key !== "string")
      )
        throw new Error();
      return new CredentialVault(
        value as Record<string, string>,
        process.env.CONNECTION_ACTIVE_KEY_ID ?? "",
      );
    } catch {
      fail(
        "INVALID_KEY_CONFIG",
        503,
        "Configure CONNECTION_TOKEN_KEYS and CONNECTION_ACTIVE_KEY_ID in the server secret store.",
      );
    }
  }

  encrypt(value: string, context: string) {
    const iv = randomBytes(12);
    const cipher = createCipheriv(
      "aes-256-gcm",
      this.keys.get(this.activeKeyId)!,
      iv,
    );
    cipher.setAAD(Buffer.from(context));
    const ciphertext = Buffer.concat([
      cipher.update(value, "utf8"),
      cipher.final(),
    ]);
    return [
      "enc1",
      this.activeKeyId,
      iv.toString("base64url"),
      cipher.getAuthTag().toString("base64url"),
      ciphertext.toString("base64url"),
    ].join(".");
  }

  decrypt(envelope: string, context: string) {
    try {
      const parts = envelope.split(".");
      if (parts.length !== 5 || parts[0] !== "enc1") throw new Error();
      const [, id, encodedIv, encodedTag, encodedBody] = parts;
      const key = this.keys.get(id);
      const iv = Buffer.from(encodedIv, "base64url");
      const tag = Buffer.from(encodedTag, "base64url");
      if (!key || iv.length !== 12 || tag.length !== 16) throw new Error();
      const decipher = createDecipheriv("aes-256-gcm", key, iv);
      decipher.setAAD(Buffer.from(context));
      decipher.setAuthTag(tag);
      return Buffer.concat([
        decipher.update(Buffer.from(encodedBody, "base64url")),
        decipher.final(),
      ]).toString("utf8");
    } catch {
      fail(
        "CREDENTIAL_UNAVAILABLE",
        503,
        "The saved credential is unavailable. Check the server key configuration or reconnect.",
      );
    }
  }
}
