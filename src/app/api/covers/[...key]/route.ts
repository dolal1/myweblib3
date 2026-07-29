import { NextResponse } from "next/server";

import { getCover, isValidStorageKey } from "@/lib/covers/service";

/**
 * Serves a cover image.
 *
 * Covers live outside `public/` because they are user-uploaded content, and
 * anything in `public/` is served verbatim by the static handler with no
 * validation. Routing them through here means the key is checked before it
 * touches the filesystem.
 *
 * Keys are content-addressed — the SHA-256 of the processed bytes — so the
 * response is genuinely immutable and can be cached for a year. The URL changes
 * when the image does, which is the whole point of content addressing.
 *
 * This is the alternative to v2's approach of base64-inlining every cover into
 * the HTML, where the bytes were re-sent on every page view and could not be
 * cached at all.
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ key: string[] }> },
) {
  const { key: segments } = await params;
  const key = segments.join("/");

  // Reject before touching the disk. The key is the only part of this request
  // the caller controls.
  if (!isValidStorageKey(key)) {
    return new NextResponse("Not found", { status: 404 });
  }

  const bytes = await getCover(key);
  if (!bytes) {
    return new NextResponse("Not found", { status: 404 });
  }

  return new NextResponse(new Uint8Array(bytes), {
    headers: {
      "Content-Type": "image/webp",
      "Content-Length": String(bytes.byteLength),
      "Cache-Control": "public, max-age=31536000, immutable",
      // Belt and braces: even though only WebP is ever stored, tell the browser
      // not to go looking for something more interesting in the bytes.
      "X-Content-Type-Options": "nosniff",
    },
  });
}
