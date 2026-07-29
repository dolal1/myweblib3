/**
 * Cover constraints shared between server and client.
 *
 * Deliberately its own module with no `server-only` marker: the upload form is a
 * Client Component and needs to state the limit to the user, but importing
 * lib/covers/service.ts would drag sharp, the filesystem, and the database into
 * the browser bundle — and would throw, because that module is server-marked.
 *
 * Keeping the number in one place means the form and the validator cannot
 * disagree about it.
 */

/** Hard ceiling on an upload, in bytes. */
export const MAX_UPLOAD_BYTES = 8 * 1024 * 1024;

/** Stored covers are resized to fit inside these bounds. */
export const MAX_COVER_WIDTH = 800;
export const MAX_COVER_HEIGHT = 1200;

/** Formats accepted from an upload. SVG is excluded on purpose — see service.ts. */
export const ACCEPTED_UPLOAD_MIME = [
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
  "image/avif",
] as const;
