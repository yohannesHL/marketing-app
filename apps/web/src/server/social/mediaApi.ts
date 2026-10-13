import type { CustomerAuth } from "../auth/customerAuth";
import { fail, privateJson, securityResponse } from "../security/errors";
import { SocialMediaStore, publicMedia } from "./mediaStore";
import { socialMediaStore } from "./runtime";

export function createSocialMediaApi(auth: CustomerAuth, store: SocialMediaStore) {
  return async (request: Request, id?: string): Promise<Response> => {
    try {
      const url = new URL(request.url);
      const content = url.pathname.endsWith("/content");
      if (content && id && ["GET", "HEAD"].includes(request.method) && url.searchParams.has("signature"))
        return await store.content(id, request);
      const principal = await auth.requireSession(request);
      if (!["GET", "HEAD"].includes(request.method)) auth.assertOrigin(request);
      if (id && content && ["GET", "HEAD"].includes(request.method))
        return await store.content(id, request, principal.userId);
      if (id && request.method === "GET") return privateJson(publicMedia(await store.owned(principal.userId, id)));
      if (id && request.method === "DELETE") return privateJson(await store.remove(principal.userId, id));
      if (!id && request.method === "POST") {
        const type = request.headers.get("content-type") ?? "";
        if (!type.toLowerCase().startsWith("multipart/form-data;") || !request.body)
          fail("INVALID_MEDIA", 400, "Upload one file using the media form.");
        const chunks: Uint8Array[] = [];
        const reader = request.body.getReader();
        let bytes = 0;
        for (;;) {
          const next = await reader.read();
          if (next.done) break;
          bytes += next.value.byteLength;
          if (bytes > store.maxBytes + 64 * 1024) {
            await reader.cancel();
            fail("INVALID_MEDIA", 413, "Choose a file within the app's upload size limit.");
          }
          chunks.push(next.value);
        }
        let form: FormData;
        try {
          form = await new Request(url, { method: "POST", headers: { "Content-Type": type },
            body: Buffer.concat(chunks) }).formData();
        } catch { fail("INVALID_MEDIA", 400, "Upload one supported media file."); }
        if ([...form.keys()].some((key) => key !== "file") || form.getAll("file").length !== 1)
          fail("INVALID_MEDIA", 400, "Upload only one media file; metadata is verified by the server.");
        const file = form.get("file");
        if (!file || typeof file === "string") fail("INVALID_MEDIA", 400, "Choose a media file.");
        return privateJson(await store.ingest(principal.userId, new Uint8Array(await file.arrayBuffer()), file.name), 201);
      }
      fail("METHOD_NOT_ALLOWED", 405, "This media action is unavailable.");
    } catch (error) { return securityResponse(error); }
  };
}

export async function handleSocialMediaApi(request: Request, id?: string) {
  try {
    const { customerAuth } = await import("../security/runtime");
    const store = socialMediaStore();
    return await createSocialMediaApi(customerAuth(), store)(request, id);
  } catch (error) { return securityResponse(error); }
}
