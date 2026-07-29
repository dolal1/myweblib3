import "server-only";

import { createHash } from "node:crypto";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

import sharp, { type Metadata as SharpMetadata } from "sharp";

import {
  MAX_COVER_HEIGHT,
  MAX_COVER_WIDTH,
  MAX_UPLOAD_BYTES,
} from "@/lib/covers/limits";
import { db } from "@/lib/db";
import { env } from "@/lib/env";

export { MAX_UPLOAD_BYTES };

/**
 * Cover images.
 *
 * This is the last of the four design limits in docs/from-v2.md to be closed.
 * v2 stored cover images as raw `Buffer`s inside the Mongo document and
 * base64-inlined them into the HTML on every render, via a form field
 * containing JSON. Four separate problems:
 *
 *   1. **Bytes in the row.** Every query that touched a book dragged the image
 *      with it, and the document size limit capped how large a cover could be.
 *      Here the row holds a storage key; the bytes live outside.
 *   2. **Uncacheable.** Inlined base64 cannot be cached separately from the
 *      page, and inflates every byte by a third. Here covers are served from
 *      their own URL with an immutable cache header.
 *   3. **Client-declared type.** v2 read `cover.type` out of JSON the browser
 *      sent and checked it against a list that contained the typo
 *      `'images/gif'` — so GIFs were rejected, and a lie about the type was
 *      accepted. Here the format is determined by decoding the image.
 *   4. **No normalisation.** Whatever was uploaded was stored. Here everything
 *      is re-encoded to a bounded WebP.
 *
 * Storage is content-addressed: the key is the SHA-256 of the *processed*
 * bytes, so identical covers are stored once and the URL can be cached forever.
 */

/** Bounds live in ./limits.ts so the client upload form can read them too. */
const MAX_WIDTH = MAX_COVER_WIDTH;
const MAX_HEIGHT = MAX_COVER_HEIGHT;

/**
 * Formats we are willing to decode.
 *
 * SVG is deliberately excluded: it is a document format that can carry scripts
 * and external references, and "an image" that can make network requests is not
 * something to accept from an upload form.
 */
const ALLOWED_INPUT_FORMATS = new Set(["jpeg", "png", "webp", "gif", "avif"]);

export type CoverFailure =
  | { kind: "too-large"; bytes: number }
  | { kind: "empty" }
  | { kind: "undecodable" }
  | { kind: "unsupported-format"; format: string }
  | { kind: "suspicious-dimensions"; width: number; height: number };

export type CoverResult<T> =
  { ok: true; data: T } | { ok: false; failure: CoverFailure };

export interface ProcessedCover {
  bytes: Buffer;
  storageKey: string;
  mimeType: string;
  width: number;
  height: number;
  byteSize: number;
  checksum: string;
}

/**
 * Validates and normalises an uploaded image.
 *
 * Note the order: size check, then *decode*, then format check. The format is
 * whatever sharp finds in the bytes, never what the client claimed.
 */
export async function processCoverBytes(
  input: Buffer,
): Promise<CoverResult<ProcessedCover>> {
  if (input.byteLength === 0) return { ok: false, failure: { kind: "empty" } };

  if (input.byteLength > MAX_UPLOAD_BYTES) {
    return {
      ok: false,
      failure: { kind: "too-large", bytes: input.byteLength },
    };
  }

  let metadata: SharpMetadata;
  try {
    metadata = await sharp(input, { failOn: "error" }).metadata();
  } catch {
    // Not an image, or a corrupt one. Either way it is not going in.
    return { ok: false, failure: { kind: "undecodable" } };
  }

  const format = metadata.format ?? "unknown";
  if (!ALLOWED_INPUT_FORMATS.has(format)) {
    return { ok: false, failure: { kind: "unsupported-format", format } };
  }

  const width = metadata.width ?? 0;
  const height = metadata.height ?? 0;
  if (width < 1 || height < 1) {
    return { ok: false, failure: { kind: "undecodable" } };
  }

  // A decompression bomb: small file, enormous declared dimensions. sharp would
  // happily allocate width * height * channels bytes trying to resize it.
  if (width * height > 50_000_000) {
    return {
      ok: false,
      failure: { kind: "suspicious-dimensions", width, height },
    };
  }

  const bytes = await sharp(input, { failOn: "error" })
    // `inside` never enlarges a small cover, and preserves aspect ratio.
    .resize({
      width: MAX_WIDTH,
      height: MAX_HEIGHT,
      fit: "inside",
      withoutEnlargement: true,
    })
    // Re-encoding strips EXIF, which can carry the photographer's GPS
    // coordinates. A library catalogue has no business storing those.
    .webp({ quality: 82 })
    .toBuffer();

  const finalMeta = await sharp(bytes).metadata();
  const checksum = createHash("sha256").update(bytes).digest("hex");

  return {
    ok: true,
    data: {
      bytes,
      // Content-addressed: the same image always produces the same key, so it
      // is stored once and the URL is safe to cache forever.
      storageKey: `${checksum.slice(0, 2)}/${checksum}.webp`,
      mimeType: "image/webp",
      width: finalMeta.width ?? 0,
      height: finalMeta.height ?? 0,
      byteSize: bytes.byteLength,
      checksum,
    },
  };
}

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------

/**
 * Disk-backed blob storage.
 *
 * The interface is deliberately three functions wide, so swapping it for S3 or
 * Vercel Blob in production touches only this section. Keys are validated on
 * the way in and out: a key is the only thing a request controls, and joining
 * unvalidated input onto a filesystem path is how directory traversal happens.
 */
const KEY_PATTERN = /^[0-9a-f]{2}\/[0-9a-f]{64}\.webp$/;

export function isValidStorageKey(key: string): boolean {
  return KEY_PATTERN.test(key);
}

function resolveKeyPath(key: string): string | null {
  if (!isValidStorageKey(key)) return null;

  const root = path.resolve(env.UPLOAD_DIR);
  const resolved = path.resolve(root, key);

  // Belt and braces. The pattern above already forbids "..", but a path that
  // escapes the root must never be read or written regardless of how it got
  // here.
  if (!resolved.startsWith(root + path.sep)) return null;
  return resolved;
}

export async function putCover(key: string, bytes: Buffer): Promise<boolean> {
  const target = resolveKeyPath(key);
  if (!target) return false;

  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, bytes);
  return true;
}

export async function getCover(key: string): Promise<Buffer | null> {
  const target = resolveKeyPath(key);
  if (!target) return null;

  try {
    return await readFile(target);
  } catch {
    return null;
  }
}

export async function deleteCover(key: string): Promise<void> {
  const target = resolveKeyPath(key);
  if (!target) return;
  await unlink(target).catch(() => {});
}

// ---------------------------------------------------------------------------
// Attaching a cover to a book
// ---------------------------------------------------------------------------

export async function attachCover(
  bookId: string,
  input: Buffer,
): Promise<CoverResult<{ storageKey: string }>> {
  const processed = await processCoverBytes(input);
  if (!processed.ok) return processed;

  const { bytes, storageKey, mimeType, width, height, byteSize, checksum } =
    processed.data;

  const stored = await putCover(storageKey, bytes);
  if (!stored) return { ok: false, failure: { kind: "undecodable" } };

  const previous = await db.cover.findUnique({
    where: { bookId },
    select: { storageKey: true },
  });

  await db.cover.upsert({
    where: { bookId },
    create: {
      bookId,
      storageKey,
      mimeType,
      width,
      height,
      byteSize,
      checksum,
    },
    update: { storageKey, mimeType, width, height, byteSize, checksum },
  });

  // Only delete the old file if nothing else points at it. Content addressing
  // means two books can legitimately share one key.
  if (previous && previous.storageKey !== storageKey) {
    const stillUsed = await db.cover.count({
      where: { storageKey: previous.storageKey },
    });
    if (stillUsed === 0) await deleteCover(previous.storageKey);
  }

  return { ok: true, data: { storageKey } };
}

/**
 * Fetches a cover from a URL — used to import the image Open Library returns
 * alongside ISBN metadata.
 *
 * Same rules as the metadata client: time out, and treat every failure as a
 * miss rather than an exception.
 */
export async function importCoverFromUrl(
  bookId: string,
  url: string,
  fetchImpl: typeof fetch = fetch,
): Promise<CoverResult<{ storageKey: string }>> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { ok: false, failure: { kind: "undecodable" } };
  }

  // Only https, and never a URL that could reach our own network. This is an
  // SSRF guard: the URL comes from a third-party API response, which is not the
  // same as trusting it.
  if (parsed.protocol !== "https:") {
    return { ok: false, failure: { kind: "undecodable" } };
  }
  if (isPrivateHost(parsed.hostname)) {
    return { ok: false, failure: { kind: "undecodable" } };
  }

  let bytes: Buffer;
  try {
    const response = await fetchImpl(parsed.toString(), {
      signal: AbortSignal.timeout(8_000),
    });
    if (!response.ok) {
      return { ok: false, failure: { kind: "undecodable" } };
    }

    const buffer = await response.arrayBuffer();
    if (buffer.byteLength > MAX_UPLOAD_BYTES) {
      return {
        ok: false,
        failure: { kind: "too-large", bytes: buffer.byteLength },
      };
    }
    bytes = Buffer.from(buffer);
  } catch {
    return { ok: false, failure: { kind: "undecodable" } };
  }

  return attachCover(bookId, bytes);
}

/** Blocks loopback, link-local, and RFC 1918 ranges. */
export function isPrivateHost(hostname: string): boolean {
  const host = hostname.toLowerCase();

  if (host === "localhost" || host.endsWith(".localhost")) return true;
  if (host === "[::1]" || host === "::1") return true;
  if (host.endsWith(".internal") || host.endsWith(".local")) return true;

  const ipv4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!ipv4) return false;

  const octets = ipv4.slice(1, 5).map(Number);
  if (octets.some((o) => Number.isNaN(o) || o > 255)) return true;

  const [a, b] = octets as [number, number, number, number];
  if (a === 10 || a === 127 || a === 0) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 169 && b === 254) return true; // link-local, incl. cloud metadata
  if (a === 100 && b >= 64 && b <= 127) return true; // carrier-grade NAT
  return false;
}

export function explainCoverFailure(failure: CoverFailure): string {
  switch (failure.kind) {
    case "empty":
      return "That file is empty.";
    case "too-large":
      return `That image is ${Math.round(failure.bytes / 1024 / 1024)} MB. The limit is ${MAX_UPLOAD_BYTES / 1024 / 1024} MB.`;
    case "undecodable":
      return "That file could not be read as an image.";
    case "unsupported-format":
      return `${failure.format.toUpperCase()} images are not accepted. Use JPEG, PNG, WebP, GIF, or AVIF.`;
    case "suspicious-dimensions":
      return `That image claims to be ${failure.width}×${failure.height}, which is too large to process.`;
  }
}
