import type { CustomerAuth } from "../auth/customerAuth";
import type { CustomerConnections } from "../connections/customerConnections";
import { fail, privateJson, readBody, securityResponse } from "./errors";

export function createCustomerApi(
  auth: CustomerAuth,
  connections: CustomerConnections,
) {
  return async (request: Request): Promise<Response> => {
    try {
      const path = new URL(request.url).pathname;
      if (path === "/api/auth/login" && request.method === "POST") {
        auth.assertOrigin(request);
        const body = await readBody(request);
        if (typeof body.email !== "string" || typeof body.password !== "string")
          fail("INVALID_LOGIN", 401, "Email or password is incorrect.");
        const login = await auth.login(body.email, body.password);
        return privateJson(login.customer, 200, { "Set-Cookie": login.cookie });
      }
      const principal = await auth.requireSession(request);
      if (!["GET", "HEAD"].includes(request.method)) auth.assertOrigin(request);
      if (path === "/api/auth/session") {
        if (request.method === "GET")
          return privateJson({ customerId: principal.userId });
        if (request.method === "DELETE")
          return privateJson({ signedOut: true }, 200, {
            "Set-Cookie": await auth.logout(principal),
          });
      }
      if (path === "/api/connections" && request.method === "GET")
        return privateJson(await connections.list(principal));
      const connection = path.match(/^\/api\/connections\/([^/]+)$/);
      if (connection) {
        if (request.method === "GET")
          return privateJson(await connections.get(principal, connection[1]));
        if (request.method === "DELETE")
          return privateJson(
            await connections.disconnect(principal, connection[1]),
          );
      }
      const destination = path.match(
        /^\/api\/connections\/destinations\/([^/]+)$/,
      );
      if (destination && request.method === "PATCH") {
        const body = await readBody(request);
        if (
          typeof body.selected !== "boolean" ||
          Object.keys(body).some((key) => key !== "selected")
        )
          fail("INVALID_SELECTION", 400, "Supply only the selected boolean.");
        return privateJson(
          await connections.selectDestination(
            principal,
            destination[1],
            body.selected,
          ),
        );
      }
      return privateJson(
        { code: "NOT_FOUND", message: "Endpoint not found." },
        404,
      );
    } catch (error) {
      return securityResponse(error);
    }
  };
}
