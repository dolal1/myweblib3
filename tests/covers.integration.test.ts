import { rm } from "node:fs/promises";
import path from "node:path";

import sharp from "sharp";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import {
  attachCover,
  deleteCover,
  getCover,
  importCoverFromUrl,
  putCover,
} from "@/lib/covers/service";
import { db } from "@/lib/db";
import { env } from "@/lib/env";

/**
 * Cover storage and attachment, against a real database and a real filesystem.
 *
 * processCoverBytes is unit-tested in covers.test.ts; this covers the parts that
 * touch state — the storage round-trip, the Cover row, replacing an existing
 * cover, and the shared-key case that content addressing creates.
 */

const PREFIX = "covi-";

async function cleanup() {
  const covers = await db.cover.findMany({
    where: { book: { title: { startsWith: PREFIX } } },
    select: { storageKey: true },
  });
  for (const cover of covers) await deleteCover(cover.storageKey);

  await db.cover.deleteMany({
    where: { book: { title: { startsWith: PREFIX } } },
  });
  await db.bookAuthor.deleteMany({
    where: { book: { title: { startsWith: PREFIX } } },
  });
  await db.book.deleteMany({ where: { title: { startsWith: PREFIX } } });
  await db.author.deleteMany({ where: { name: { startsWith: PREFIX } } });
}

async function makeBook(suffix = "0") {
  const author = await db.author.create({
    data: { name: `${PREFIX}a${suffix}`, sortName: `${PREFIX}a${suffix}` },
  });
  return db.book.create({
    data: {
      title: `${PREFIX}book${suffix}`,
      authors: { create: [{ authorId: author.id, role: "AUTHOR" }] },
    },
    select: { id: true },
  });
}

function image(width = 400, height = 600, shade = 100): Promise<Buffer> {
  return sharp({
    create: {
      width,
      height,
      channels: 3,
      background: { r: shade, g: shade, b: shade },
    },
  })
    .jpeg()
    .toBuffer();
}

beforeEach(cleanup);
afterAll(async () => {
  await cleanup();
  await db.$disconnect();
});

describe("storage round-trip", () => {
  it("writes and reads bytes back unchanged", async () => {
    const bytes = Buffer.from("not-really-an-image-but-bytes-are-bytes");
    const key = `ab/${"c".repeat(64)}.webp`;

    await expect(putCover(key, bytes)).resolves.toBe(true);
    const read = await getCover(key);
    expect(read?.equals(bytes)).toBe(true);

    await deleteCover(key);
    await expect(getCover(key)).resolves.toBeNull();
    await rm(path.join(path.resolve(env.UPLOAD_DIR), "ab"), {
      recursive: true,
      force: true,
    });
  });

  it("refuses to write outside the upload directory", async () => {
    // putCover returns false rather than throwing, and writes nothing.
    for (const key of ["../escaped.webp", "/etc/passwd", "ab/../../x.webp"]) {
      await expect(putCover(key, Buffer.from("x"))).resolves.toBe(false);
    }
  });

  it("returns null for a malformed key rather than reading anything", async () => {
    for (const key of ["../../../etc/passwd", "nope", ""]) {
      await expect(getCover(key)).resolves.toBeNull();
    }
  });
});

describe("attachCover", () => {
  it("normalises, stores, and records the cover", async () => {
    const book = await makeBook();
    // Oversized, with EXIF that must not survive.
    const source = await sharp({
      create: {
        width: 1600,
        height: 2400,
        channels: 3,
        background: { r: 90, g: 30, b: 30 },
      },
    })
      .withExif({ IFD0: { Artist: "should-be-stripped" } })
      .jpeg()
      .toBuffer();

    const result = await attachCover(book.id, source);
    expect(result.ok).toBe(true);

    const row = await db.cover.findUniqueOrThrow({
      where: { bookId: book.id },
    });
    expect(row.mimeType).toBe("image/webp");
    // Resized to fit inside 800x1200, preserving the 2:3 ratio.
    expect(row.width).toBe(800);
    expect(row.height).toBe(1200);
    // Re-encoding to WebP should be substantially smaller than the JPEG.
    expect(row.byteSize).toBeLessThan(source.byteLength);

    const stored = await getCover(row.storageKey);
    expect(stored).not.toBeNull();
    const meta = await sharp(stored!).metadata();
    expect(meta.format).toBe("webp");
    expect(meta.exif).toBeUndefined();
    // The checksum recorded must be of the bytes actually on disk.
    expect(row.byteSize).toBe(stored!.byteLength);
  });

  it("replaces an existing cover and removes the orphaned file", async () => {
    const book = await makeBook();

    const first = await attachCover(book.id, await image(400, 600, 10));
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    const second = await attachCover(book.id, await image(400, 600, 200));
    expect(second.ok).toBe(true);
    if (!second.ok) return;

    expect(second.data.storageKey).not.toBe(first.data.storageKey);
    // One Cover row per book — the schema has a unique index on bookId.
    await expect(
      db.cover.count({ where: { bookId: book.id } }),
    ).resolves.toBe(1);
    // The superseded file is gone.
    await expect(getCover(first.data.storageKey)).resolves.toBeNull();
    await expect(getCover(second.data.storageKey)).resolves.not.toBeNull();
  });

  it("keeps the file when another book still shares the key", async () => {
    // Content addressing means two books with the same artwork share one file.
    // Removing one must not break the other.
    const [a, b] = await Promise.all([makeBook("a"), makeBook("b")]);
    const same = await image(400, 600, 55);

    const one = await attachCover(a.id, same);
    const two = await attachCover(b.id, same);
    expect(one.ok && two.ok).toBe(true);
    if (!one.ok || !two.ok) return;
    expect(one.data.storageKey).toBe(two.data.storageKey);

    // Replace a's cover; the shared file must survive for b.
    await attachCover(a.id, await image(400, 600, 240));
    await expect(getCover(two.data.storageKey)).resolves.not.toBeNull();
  });

  it("rejects a non-image without creating a row", async () => {
    const book = await makeBook();
    const result = await attachCover(book.id, Buffer.from("#!/bin/sh\n"));

    expect(result.ok).toBe(false);
    await expect(
      db.cover.count({ where: { bookId: book.id } }),
    ).resolves.toBe(0);
  });

  it("is removed when the book is deleted", async () => {
    const book = await makeBook();
    await attachCover(book.id, await image());

    // Cover.book is onDelete: Cascade — a cover with no book is meaningless.
    await db.bookAuthor.deleteMany({ where: { bookId: book.id } });
    await db.book.delete({ where: { id: book.id } });

    await expect(
      db.cover.count({ where: { bookId: book.id } }),
    ).resolves.toBe(0);
  });
});

describe("importCoverFromUrl", () => {
  it("imports an image from a public https URL", async () => {
    const book = await makeBook();
    const bytes = await image(300, 450, 77);

    const result = await importCoverFromUrl(
      book.id,
      "https://covers.example.org/cover.jpg",
      async () =>
        new Response(new Uint8Array(bytes), {
          status: 200,
          headers: { "Content-Type": "image/jpeg" },
        }),
    );

    expect(result.ok).toBe(true);
    await expect(
      db.cover.count({ where: { bookId: book.id } }),
    ).resolves.toBe(1);
  });

  it("refuses http, and refuses to fetch a private address", async () => {
    const book = await makeBook();
    let called = false;
    const spy: typeof fetch = async () => {
      called = true;
      return new Response(null, { status: 200 });
    };

    for (const url of [
      "http://covers.example.org/c.jpg", // not https
      "https://localhost/c.jpg",
      "https://127.0.0.1/c.jpg",
      "https://169.254.169.254/latest/meta-data/", // cloud metadata
      "https://10.0.0.5/c.jpg",
      "not-a-url",
    ]) {
      const result = await importCoverFromUrl(book.id, url, spy);
      expect(result.ok, url).toBe(false);
    }

    // The SSRF guard must run before the request, not after.
    expect(called).toBe(false);
  });

  it("degrades gracefully when the fetch fails or returns nonsense", async () => {
    const book = await makeBook();

    const failed = await importCoverFromUrl(
      book.id,
      "https://covers.example.org/c.jpg",
      async () => {
        throw new TypeError("fetch failed");
      },
    );
    expect(failed.ok).toBe(false);

    const notAnImage = await importCoverFromUrl(
      book.id,
      "https://covers.example.org/c.jpg",
      async () => new Response("<html>404</html>", { status: 200 }),
    );
    expect(notAnImage.ok).toBe(false);

    const notOk = await importCoverFromUrl(
      book.id,
      "https://covers.example.org/c.jpg",
      async () => new Response(null, { status: 500 }),
    );
    expect(notOk.ok).toBe(false);

    await expect(
      db.cover.count({ where: { bookId: book.id } }),
    ).resolves.toBe(0);
  });
});
