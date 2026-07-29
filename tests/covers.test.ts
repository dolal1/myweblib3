import { describe, expect, it } from "vitest";
import sharp from "sharp";

import {
  explainCoverFailure,
  isPrivateHost,
  isValidStorageKey,
  processCoverBytes,
} from "@/lib/covers/service";
import { MAX_UPLOAD_BYTES } from "@/lib/covers/limits";

/**
 * Cover processing.
 *
 * The interesting assertions are the rejections. v2 read the image type out of
 * JSON the browser sent and checked it against a list containing the typo
 * `'images/gif'`, which means it both trusted a client-declared type and got the
 * list wrong. Everything here is decided by decoding the actual bytes.
 */

/** Builds a real encoded image, so sharp has something genuine to decode. */
async function makeImage(
  format: "jpeg" | "png" | "webp" | "gif" | "tiff",
  width = 400,
  height = 600,
): Promise<Buffer> {
  const base = sharp({
    create: {
      width,
      height,
      channels: 3,
      background: { r: 120, g: 80, b: 40 },
    },
  });
  return base[format]().toBuffer();
}

describe("processCoverBytes", () => {
  it("accepts a JPEG and normalises it to WebP", async () => {
    const result = await processCoverBytes(await makeImage("jpeg"));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.mimeType).toBe("image/webp");
    expect(result.data.width).toBe(400);
    expect(result.data.height).toBe(600);
    expect(result.data.byteSize).toBeGreaterThan(0);
  });

  it("accepts every format we claim to accept, including GIF", async () => {
    // v2's allow-list said 'images/gif', so GIFs were silently rejected.
    for (const format of ["jpeg", "png", "webp", "gif"] as const) {
      const result = await processCoverBytes(await makeImage(format));
      expect(result.ok, `${format} should be accepted`).toBe(true);
    }
  });

  it("rejects a format we do not accept, by decoding rather than by extension", async () => {
    // TIFF is a real image sharp can read; it is simply not on our list.
    const result = await processCoverBytes(await makeImage("tiff"));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.kind).toBe("unsupported-format");
  });

  it("rejects an SVG even though sharp can decode it", async () => {
    // SVG can carry scripts and fetch external resources. An "image" that makes
    // network requests has no business coming from an upload form.
    const svg = Buffer.from(
      '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"></svg>',
    );
    const result = await processCoverBytes(svg);
    expect(result.ok).toBe(false);
  });

  it("rejects a file that is not an image at all", async () => {
    const result = await processCoverBytes(
      Buffer.from("#!/bin/sh\nrm -rf /\n"),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.kind).toBe("undecodable");
  });

  it("rejects a JPEG header with garbage after it", async () => {
    // A real magic number does not make a real image. This is what "trust the
    // declared type" gets you.
    const fake = Buffer.concat([
      Buffer.from([0xff, 0xd8, 0xff, 0xe0]),
      Buffer.alloc(2048, 0x41),
    ]);
    const result = await processCoverBytes(fake);
    expect(result.ok).toBe(false);
  });

  it("rejects an empty file", async () => {
    const result = await processCoverBytes(Buffer.alloc(0));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.kind).toBe("empty");
  });

  it("rejects an oversized upload before decoding it", async () => {
    const huge = Buffer.alloc(MAX_UPLOAD_BYTES + 1, 0);
    const result = await processCoverBytes(huge);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.kind).toBe("too-large");
  });

  it("shrinks an oversized image but never enlarges a small one", async () => {
    const big = await processCoverBytes(await makeImage("jpeg", 2000, 3000));
    expect(big.ok).toBe(true);
    if (big.ok) {
      // Fits inside 800x1200, preserving the 2:3 ratio.
      expect(big.data.width).toBeLessThanOrEqual(800);
      expect(big.data.height).toBeLessThanOrEqual(1200);
      expect(big.data.width).toBe(800);
    }

    const small = await processCoverBytes(await makeImage("jpeg", 100, 150));
    expect(small.ok).toBe(true);
    if (small.ok) {
      // withoutEnlargement: a thumbnail stays a thumbnail rather than being
      // upscaled into a blurry mess.
      expect(small.data.width).toBe(100);
      expect(small.data.height).toBe(150);
    }
  });

  it("produces a content-addressed key that matches the checksum", async () => {
    const result = await processCoverBytes(await makeImage("png"));
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const { storageKey, checksum } = result.data;
    expect(storageKey).toBe(`${checksum.slice(0, 2)}/${checksum}.webp`);
    expect(isValidStorageKey(storageKey)).toBe(true);
  });

  it("gives identical bytes the same key, so a shared cover is stored once", async () => {
    const source = await makeImage("png");
    const [a, b] = await Promise.all([
      processCoverBytes(source),
      processCoverBytes(source),
    ]);

    expect(a.ok && b.ok).toBe(true);
    if (a.ok && b.ok) expect(a.data.storageKey).toBe(b.data.storageKey);
  });

  it("gives different images different keys", async () => {
    const [a, b] = await Promise.all([
      processCoverBytes(await makeImage("png", 400, 600)),
      processCoverBytes(await makeImage("png", 300, 500)),
    ]);
    if (a.ok && b.ok) expect(a.data.storageKey).not.toBe(b.data.storageKey);
  });

  it("strips metadata by re-encoding", async () => {
    const withExif = await sharp({
      create: {
        width: 200,
        height: 300,
        channels: 3,
        background: { r: 1, g: 2, b: 3 },
      },
    })
      .withExif({ IFD0: { Copyright: "someone", Artist: "someone else" } })
      .jpeg()
      .toBuffer();

    const result = await processCoverBytes(withExif);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // EXIF can carry GPS coordinates. A library catalogue should not store
    // where a photo of a book jacket was taken.
    const meta = await sharp(result.data.bytes).metadata();
    expect(meta.exif).toBeUndefined();
  });

  it("explains every failure kind in prose", () => {
    const failures = [
      { kind: "empty" },
      { kind: "too-large", bytes: 20_000_000 },
      { kind: "undecodable" },
      { kind: "unsupported-format", format: "tiff" },
      { kind: "suspicious-dimensions", width: 60_000, height: 60_000 },
    ] as const;

    for (const failure of failures) {
      const message = explainCoverFailure(failure);
      expect(message.length).toBeGreaterThan(10);
      expect(message).toMatch(/[.!]$/);
    }
  });
});

describe("isValidStorageKey", () => {
  const valid = `ab/${"a".repeat(64)}.webp`;

  it("accepts the shape processCoverBytes produces", () => {
    expect(isValidStorageKey(valid)).toBe(true);
  });

  it("rejects directory traversal", () => {
    // The key is the only part of a cover request the caller controls, so this
    // is the whole defence for the file read.
    for (const key of [
      "../../../etc/passwd",
      "ab/../../../etc/passwd",
      `ab/${"a".repeat(64)}.webp/../../secret`,
      "..%2F..%2Fetc%2Fpasswd",
      "/etc/passwd",
      "ab/passwd",
    ]) {
      expect(isValidStorageKey(key), key).toBe(false);
    }
  });

  it("rejects the wrong extension, wrong length, and non-hex characters", () => {
    expect(isValidStorageKey(`ab/${"a".repeat(64)}.png`)).toBe(false);
    expect(isValidStorageKey(`ab/${"a".repeat(63)}.webp`)).toBe(false);
    expect(isValidStorageKey(`ab/${"z".repeat(64)}.webp`)).toBe(false);
    expect(isValidStorageKey(`AB/${"a".repeat(64)}.webp`)).toBe(false);
    expect(isValidStorageKey("")).toBe(false);
  });
});

describe("isPrivateHost", () => {
  it("blocks loopback and link-local", () => {
    // The cover URL comes from a third-party API response. Fetching it without
    // checking is server-side request forgery waiting to happen.
    for (const host of [
      "localhost",
      "app.localhost",
      "127.0.0.1",
      "127.1.1.1",
      "0.0.0.0",
      "::1",
      "[::1]",
      "169.254.169.254", // cloud instance metadata
      "metadata.internal",
      "printer.local",
    ]) {
      expect(isPrivateHost(host), host).toBe(true);
    }
  });

  it("blocks RFC 1918 and carrier-grade NAT ranges", () => {
    for (const host of [
      "10.0.0.1",
      "10.255.255.255",
      "172.16.0.1",
      "172.31.255.255",
      "192.168.1.1",
      "100.64.0.1",
    ]) {
      expect(isPrivateHost(host), host).toBe(true);
    }
  });

  it("allows ordinary public hosts", () => {
    for (const host of [
      "openlibrary.org",
      "covers.openlibrary.org",
      "8.8.8.8",
      "172.32.0.1", // just outside the 172.16/12 block
      "192.169.1.1", // just outside 192.168/16
      "11.0.0.1",
    ]) {
      expect(isPrivateHost(host), host).toBe(false);
    }
  });
});
