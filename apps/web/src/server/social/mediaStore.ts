import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { execFile } from "node:child_process";
import { createReadStream } from "node:fs";
import { chmod, lstat, mkdir, realpath, unlink, writeFile } from "node:fs/promises";
import { basename, isAbsolute, join } from "node:path";
import { Readable } from "node:stream";
import { promisify } from "node:util";
import type { PrismaClient, SocialMediaAsset } from "../../generated/prisma/client";
import { fail } from "../security/errors";

const run = promisify(execFile);
const identifier = /^[A-Za-z0-9_-]{1,128}$/;
const storageIdentifier = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
type Configuration = { directory: string; origin: string; signingKey: string;
  mode: "mock" | "live"; maxBytes?: number; probeExecutable?: string };

export function publicMedia(asset: SocialMediaAsset) {
  const source = asset.metadata && typeof asset.metadata === "object" && !Array.isArray(asset.metadata)
    ? asset.metadata as Record<string, unknown> : {};
  const metadata: Record<string, string | number> = {};
  for (const key of ["container", "videoCodec", "audioCodec"]) {
    const value = source[key];
    if (typeof value === "string" && /^[A-Za-z0-9_,/.-]{0,80}$/.test(value)) metadata[key] = value;
  }
  for (const key of ["fps", "audioSampleRate", "rotation"]) {
    const value = source[key];
    if (typeof value === "number" && Number.isFinite(value)) metadata[key] = value;
  }
  return { id: asset.id, filename: asset.filename, bytes: asset.bytes, mime: asset.mime,
    type: asset.type, width: asset.width, height: asset.height, durationMs: asset.durationMs,
    expiresAt: asset.expiresAt, status: asset.status, metadata };
}

/** Bytes and probe results are trusted server evidence; browser claims are never accepted. */
export class SocialMediaStore {
  readonly maxBytes: number;
  readonly origin: string;
  private readonly signingKey: Buffer;
  constructor(private readonly db: PrismaClient, private readonly config: Configuration,
    private readonly now = () => new Date()) {
    let origin: URL;
    try { origin = new URL(config.origin); } catch { fail("INVALID_CONFIG", 503, "Configure the social media origin."); }
    const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(origin.hostname);
    if (origin.username || origin.password || origin.pathname !== "/" || origin.search || origin.hash ||
      !(origin.protocol === "https:" || (config.mode === "mock" && loopback && origin.protocol === "http:")) ||
      !isAbsolute(config.directory)) fail("INVALID_CONFIG", 503, "Configure a persistent media directory and trusted media origin.");
    this.signingKey = Buffer.from(config.signingKey, "base64");
    if (this.signingKey.length !== 32 || this.signingKey.toString("base64") !== config.signingKey)
      fail("INVALID_CONFIG", 503, "Configure a canonical 32-byte social media signing key.");
    this.maxBytes = config.maxBytes ?? 64 * 1024 * 1024;
    if (!Number.isSafeInteger(this.maxBytes) || this.maxBytes < 1024 || this.maxBytes > 512 * 1024 * 1024)
      fail("INVALID_CONFIG", 503, "Configure a supported media upload limit.");
    this.origin = origin.origin;
  }

  private async directory() {
    await mkdir(this.config.directory, { recursive: true, mode: 0o700 });
    const info = await lstat(this.config.directory);
    if (!info.isDirectory() || info.isSymbolicLink()) fail("MEDIA_UNAVAILABLE", 503, "Media storage is unavailable.");
    return realpath(this.config.directory);
  }

  async ingest(ownerId: string, bytes: Uint8Array, filename?: string) {
    if (!bytes.byteLength || bytes.byteLength > this.maxBytes)
      fail("INVALID_MEDIA", 413, "Choose a file within the app's upload size limit.");
    const sample = Buffer.from(bytes.buffer, bytes.byteOffset, Math.min(bytes.byteLength, 32));
    const mime = sample.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff])) ? "image/jpeg"
      : sample.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ? "image/png"
      : sample.subarray(4, 8).toString() === "ftyp" ? "video/mp4" : null;
    if (!mime) fail("INVALID_MEDIA", 422, "Choose a JPEG, PNG or MP4 file.");
    const storageKey = randomUUID();
    const path = join(await this.directory(), storageKey);
    await writeFile(path, bytes, { flag: "wx", mode: 0o600 });
    try {
      let probe: { streams?: Record<string, unknown>[]; format?: Record<string, unknown> };
      try {
        const result = await run(this.config.probeExecutable ?? "ffprobe", ["-v", "error", "-max_alloc", "67108864",
          "-protocol_whitelist", "file", "-show_entries",
          "stream=codec_type,codec_name,width,height,duration,r_frame_rate,sample_rate:stream_tags=rotate:stream_side_data=rotation:format=format_name,duration",
          "-of", "json", ...(mime === "video/mp4" ? ["-enable_drefs", "0", "-use_absolute_path", "0"] : []),
          "-i", path], { timeout: 15_000, maxBuffer: 128 * 1024 });
        // ffprobe may emit decode errors while still returning exit code zero.
        if (result.stderr.trim()) throw new Error("Media inspection reported a decode error.");
        probe = JSON.parse(result.stdout);
      } catch (error) {
        if (error && typeof error === "object" && "code" in error && error.code === "ENOENT")
          fail("MEDIA_INSPECTION_UNAVAILABLE", 503, "Media inspection is unavailable. Contact your workspace administrator.");
        fail("INVALID_MEDIA", 422, "This file could not be inspected. Choose a supported media file.");
      }
      const streams = probe.streams;
      const videos = streams?.filter((stream) => stream.codec_type === "video");
      const audio = streams?.filter((stream) => stream.codec_type === "audio");
      if (!videos || videos.length !== 1 || (audio?.length ?? 0) > 1)
        fail("INVALID_MEDIA", 422, "Choose media with one supported video or image stream.");
      const video = videos[0];
      let width = Number(video.width), height = Number(video.height);
      if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1 || width > 8192 || height > 8192)
        fail("INVALID_MEDIA", 422, "Choose media with supported dimensions.");
      const tags = video.tags as { rotate?: unknown } | undefined;
      const sideData = video.side_data_list as { rotation?: unknown }[] | undefined;
      const rotation = Number(sideData?.find((item) => item.rotation !== undefined)?.rotation ?? tags?.rotate ?? 0);
      if (!Number.isFinite(rotation) || rotation % 90 !== 0) fail("INVALID_MEDIA", 422, "This media rotation is unsupported.");
      if (Math.abs(rotation % 180) === 90) [width, height] = [height, width];
      const image = mime.startsWith("image/");
      if (image && audio?.length) fail("INVALID_MEDIA", 422, "Choose an image without extra media streams.");
      let durationMs: number | null = null;
      if (image ? video.codec_name !== (mime === "image/jpeg" ? "mjpeg" : "png")
        : !["h264", "hevc"].includes(String(video.codec_name)))
        fail("INVALID_MEDIA", 422, "Choose a supported image or H.264/HEVC MP4 video.");
      if (!image) {
        const duration = Number(probe.format?.duration ?? video.duration);
        if (!Number.isFinite(duration) || duration <= 0 || duration > 3 * 60 * 60)
          fail("INVALID_MEDIA", 422, "Choose video with a valid supported duration.");
        durationMs = Math.ceil(duration * 1000);
        if (!String(probe.format?.format_name ?? "").split(",").includes("mp4"))
          fail("INVALID_MEDIA", 422, "Choose an MP4 video container.");
      }
      const rate = String(video.r_frame_rate ?? "0/1").split("/").map(Number);
      const fps = rate.length === 2 && rate[1] > 0 ? rate[0] / rate[1] : 0;
      const sampleRate = Number(audio?.[0]?.sample_rate ?? 0);
      await chmod(path, 0o400);
      const asset = await this.db.socialMediaAsset.create({ data: {
        ownerId, storageKey, digest: createHash("sha256").update(bytes).digest("hex"),
        bytes: bytes.byteLength, mime, type: image ? "IMAGE" : "VIDEO", width, height, durationMs,
        filename: filename ? basename(filename).replace(/[\u0000-\u001f\u007f]/g, "").slice(0, 160) : null,
        verifiedAt: this.now(), status: "AVAILABLE", metadata: {
          container: image ? mime : "mp4", videoCodec: String(video.codec_name),
          audioCodec: String(audio?.[0]?.codec_name ?? ""), fps: Number.isFinite(fps) ? fps : 0,
          audioSampleRate: Number.isFinite(sampleRate) ? sampleRate : 0, rotation,
        },
      } });
      return publicMedia(asset);
    } catch (error) { await unlink(path).catch(() => {}); throw error; }
  }

  async owned(ownerId: string, id: string) {
    if (!identifier.test(id)) fail("NOT_FOUND", 404, "Media not found.");
    const asset = await this.db.socialMediaAsset.findFirst({ where: { id, ownerId } });
    if (!asset) fail("NOT_FOUND", 404, "Media not found.");
    return asset;
  }

  private async verifiedFile(asset: SocialMediaAsset, minimumValidUntil = this.now()) {
    if (asset.status !== "AVAILABLE" || !asset.verifiedAt ||
      (asset.expiresAt && asset.expiresAt < minimumValidUntil) || !storageIdentifier.test(asset.storageKey))
      fail("MEDIA_UNAVAILABLE", 409, "This media is missing, expired or unavailable. Upload it again before publishing.");
    const path = join(await this.directory(), asset.storageKey);
    const info = await lstat(path).catch(() => null);
    if (!info?.isFile() || info.isSymbolicLink() || info.size !== asset.bytes || info.size > this.maxBytes)
      fail("MEDIA_UNAVAILABLE", 409, "This media is unavailable. Upload it again before publishing.");
    const hash = createHash("sha256");
    for await (const chunk of createReadStream(path)) hash.update(chunk);
    if (hash.digest("hex") !== asset.digest) fail("MEDIA_UNAVAILABLE", 409, "This media changed. Upload it again before publishing.");
    return path;
  }

  private signature(asset: SocialMediaAsset, expires: number) {
    return createHmac("sha256", this.signingKey).update(`${asset.id}:${asset.digest}:${expires}`).digest("hex");
  }

  /** Called only by the private delivery resolver after review, lease and grant checks. */
  async resolve(request: { ownerId: string; media: readonly SocialMediaAsset[]; minimumValidUntil: Date }) {
    const now = this.now().getTime();
    if (!Number.isFinite(request.minimumValidUntil.getTime()) || request.minimumValidUntil.getTime() > now + 2 * 60 * 60 * 1000)
      fail("MEDIA_UNAVAILABLE", 409, "The media download window exceeds the configured limit.");
    const expires = Math.floor((now + 2 * 60 * 60 * 1000) / 1000);
    const output = [];
    for (const record of request.media) {
      const asset = await this.owned(request.ownerId, record.id);
      if (asset.digest !== record.digest) fail("MEDIA_UNAVAILABLE", 409, "The reviewed media changed.");
      await this.verifiedFile(asset, request.minimumValidUntil);
      const url = new URL(`/api/social/media/${asset.id}/content`, this.origin);
      url.searchParams.set("expires", String(expires));
      url.searchParams.set("signature", this.signature(asset, expires));
      output.push(Object.freeze({ id: asset.id, url: url.href }));
    }
    return Object.freeze(output);
  }

  async content(id: string, request: Request, ownerId?: string) {
    if (!identifier.test(id)) fail("NOT_FOUND", 404, "Media not found.");
    const asset = ownerId ? await this.owned(ownerId, id) : await this.db.socialMediaAsset.findUnique({ where: { id } });
    if (!asset) fail("NOT_FOUND", 404, "Media not found.");
    if (!ownerId) {
      const params = new URL(request.url).searchParams;
      const values = [...params.keys()];
      const rawExpiry = params.get("expires"), signature = params.get("signature");
      const expires = Number(rawExpiry);
      if (values.length !== 2 || params.getAll("expires").length !== 1 || params.getAll("signature").length !== 1 ||
        !/^\d{10}$/.test(rawExpiry ?? "") || !/^[a-f0-9]{64}$/.test(signature ?? "") ||
        expires <= Math.floor(this.now().getTime() / 1000) || expires > Math.floor(this.now().getTime() / 1000) + 7200 ||
        !timingSafeEqual(Buffer.from(signature!, "hex"), Buffer.from(this.signature(asset, expires), "hex")))
        fail("NOT_FOUND", 404, "Media not found.");
    }
    const path = await this.verifiedFile(asset);
    let start = 0, end = asset.bytes - 1, status = 200;
    const range = request.headers.get("range");
    if (range) {
      const parsed = /^bytes=(\d+)-(\d*)$/.exec(range);
      if (!parsed) fail("INVALID_RANGE", 416, "Use one supported media byte range.");
      start = Number(parsed[1]); end = parsed[2] ? Number(parsed[2]) : end;
      if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start || end >= asset.bytes)
        fail("INVALID_RANGE", 416, "This media byte range is unavailable.");
      status = 206;
    }
    return new Response(request.method === "HEAD" ? null : Readable.toWeb(createReadStream(path, { start, end })) as ReadableStream<Uint8Array>, {
      status, headers: { "Content-Type": asset.mime, "Content-Length": String(end - start + 1),
        "Accept-Ranges": "bytes", "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff",
        "Referrer-Policy": "no-referrer", ...(status === 206 ? { "Content-Range": `bytes ${start}-${end}/${asset.bytes}` } : {}) },
    });
  }

  async remove(ownerId: string, id: string) {
    const asset = await this.owned(ownerId, id);
    await this.db.socialMediaAsset.update({ where: { id: asset.id }, data: { status: "DELETED" } });
    if (storageIdentifier.test(asset.storageKey)) await unlink(join(await this.directory(), asset.storageKey)).catch(() => {});
    return { removed: true };
  }
}
