import { createHash, randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import type { PrismaClient } from "../../generated/prisma/client";
import { fail } from "../security/errors";

export type CustomerPrincipal = Readonly<{ userId: string; sessionId: string }>;
export const digest = (value: string) =>
  createHash("sha256").update(value).digest("hex");
const SESSION_DURATION = 7 * 24 * 60 * 60 * 1000;
const LOGIN_WINDOW = 15 * 60 * 1000;
const SCRYPT_OPTIONS = { N: 32768, r: 8, p: 3, maxmem: 64 * 1024 * 1024 };

function derive(password: string, salt: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, 64, SCRYPT_OPTIONS, (error, key) =>
      error ? reject(error) : resolve(key),
    );
  });
}

export class CustomerAuth {
  readonly origin: string;
  readonly cookieName: string;
  private readonly secure: boolean;
  constructor(
    private readonly db: PrismaClient,
    config: { origin: string },
    private readonly now = () => new Date(),
  ) {
    const parsed = new URL(config.origin);
    this.origin = parsed.origin;
    this.secure = parsed.protocol === "https:";
    if (
      parsed.username ||
      parsed.password ||
      parsed.pathname !== "/" ||
      parsed.search ||
      parsed.hash ||
      (!this.secure &&
        !["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname))
    ) {
      fail(
        "INVALID_CONFIG",
        503,
        "APP_ORIGIN must be an HTTPS origin or local loopback origin.",
      );
    }
    this.cookieName = this.secure
      ? "__Host-launchpad_session"
      : "launchpad_session";
  }

  assertOrigin(request: Request) {
    if (request.headers.get("origin") !== this.origin) {
      fail("INVALID_ORIGIN", 403, "The request origin is not allowed.");
    }
  }

  // Trusted operator entry point; deliberately not exposed as public signup.
  async provisionCustomer(input: {
    email: string;
    name: string;
    password: string;
    userId?: string;
  }) {
    const email = input.email.trim().toLowerCase();
    if (
      !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ||
      email.length > 254 ||
      !input.name.trim() ||
      input.name.length > 200 ||
      input.password.length < 15 ||
      input.password.length > 256
    ) {
      fail(
        "INVALID_CUSTOMER",
        400,
        "Supply a valid email, name and password of 15 to 256 characters.",
      );
    }
    const salt = randomBytes(16).toString("hex");
    const key = await derive(input.password, salt);
    const data = {
      email,
      loginEmail: email,
      name: input.name.trim(),
      passwordHash: `scrypt-v1:${salt}:${key.toString("hex")}`,
    };
    return this.db.$transaction(async (tx) => {
      const user = input.userId
        ? await tx.user.update({
            where: { id: input.userId },
            data,
            select: { id: true, email: true, name: true },
          })
        : await tx.user.create({
            data,
            select: { id: true, email: true, name: true },
          });
      await tx.customerSession.deleteMany({ where: { userId: user.id } });
      await tx.loginAttempt.deleteMany({ where: { key: digest(email) } });
      return user;
    });
  }

  async login(email: string, password: string) {
    if (
      typeof email !== "string" ||
      typeof password !== "string" ||
      email.length > 254 ||
      password.length > 256
    ) {
      fail("INVALID_LOGIN", 401, "Email or password is incorrect.");
    }
    const normalized = email.trim().toLowerCase();
    const key = digest(normalized);
    const now = this.now();
    const count = await this.db.$transaction(async (tx) => {
      await tx.loginAttempt.deleteMany({
        where: {
          key,
          windowStart: { lte: new Date(now.getTime() - LOGIN_WINDOW) },
        },
      });
      return tx.loginAttempt.upsert({
        where: { key },
        create: { key, windowStart: now, count: 1 },
        update: { count: { increment: 1 } },
      });
    });
    if (count.count > 10)
      fail("LOGIN_LIMIT", 429, "Too many sign-in attempts. Try again later.");
    const user = await this.db.user.findUnique({
      where: { loginEmail: normalized },
    });
    // Use the same expensive derivation for a nonexistent customer.
    const [version, salt, encoded] = (
      user?.passwordHash ??
      "scrypt-v1:00000000000000000000000000000000:" + "00".repeat(64)
    ).split(":");
    const expected = Buffer.from(encoded ?? "", "hex");
    const actual = await derive(password, salt ?? "invalid");
    if (
      !user ||
      version !== "scrypt-v1" ||
      expected.length !== actual.length ||
      !timingSafeEqual(expected, actual)
    ) {
      fail("INVALID_LOGIN", 401, "Email or password is incorrect.");
    }
    const token = randomBytes(32).toString("base64url");
    const expiresAt = new Date(now.getTime() + SESSION_DURATION);
    const customer = await this.db.$transaction(async (tx) => {
      // Password verification is expensive; an operator may reset access while
      // it runs. Recheck the verified snapshot atomically with session creation.
      const current = await tx.user.findFirst({
        where: {
          id: user.id,
          loginEmail: normalized,
          passwordHash: user.passwordHash,
        },
        select: { id: true, email: true, name: true },
      });
      if (!current)
        fail("INVALID_LOGIN", 401, "Email or password is incorrect.");
      await tx.customerSession.create({
        data: { userId: current.id, tokenHash: digest(token), expiresAt },
      });
      return current;
    });
    return {
      customer,
      cookie: this.cookie(token, SESSION_DURATION / 1000),
    };
  }

  private cookie(token: string, maxAge: number) {
    return `${this.cookieName}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${this.secure ? "; Secure" : ""}`;
  }

  async requireSession(request: Request): Promise<CustomerPrincipal> {
    const cookies = (request.headers.get("cookie") ?? "")
      .split(";")
      .map((part) => part.trim());
    const token = cookies
      .find((part) => part.startsWith(this.cookieName + "="))
      ?.slice(this.cookieName.length + 1);
    if (!token || !/^[A-Za-z0-9_-]{43}$/.test(token))
      fail("UNAUTHENTICATED", 401, "Sign in to continue.");
    const session = await this.db.customerSession.findUnique({
      where: { tokenHash: digest(token) },
    });
    if (!session || session.expiresAt <= this.now())
      fail("UNAUTHENTICATED", 401, "Sign in to continue.");
    return Object.freeze({ userId: session.userId, sessionId: session.id });
  }

  async assertSession(principal: CustomerPrincipal) {
    const session = await this.db.customerSession.findFirst({
      where: {
        id: principal.sessionId,
        userId: principal.userId,
        expiresAt: { gt: this.now() },
      },
    });
    if (!session) fail("UNAUTHENTICATED", 401, "Sign in to continue.");
  }

  async logout(principal: CustomerPrincipal) {
    await this.assertSession(principal);
    await this.db.customerSession.delete({
      where: { id: principal.sessionId },
    });
    return this.cookie("", 0);
  }
}
