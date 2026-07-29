"use client";

import { useActionState } from "react";
import { useFormStatus } from "react-dom";

import {
  removeCoverAction,
  uploadCoverAction,
  type CoverState,
} from "@/app/actions/covers";
import { MAX_UPLOAD_BYTES } from "@/lib/covers/limits";

export function CoverUpload({
  bookId,
  hasCover,
}: {
  bookId: string;
  hasCover: boolean;
}) {
  const upload = uploadCoverAction.bind(null, bookId);
  const [state, formAction] = useActionState<CoverState, FormData>(upload, {});
  const [removeState, removeAction] = useActionState<CoverState, FormData>(
    removeCoverAction,
    {},
  );

  const message = state.message ?? removeState.message;
  const ok = state.ok ?? removeState.ok;

  return (
    <div className="space-y-3">
      {message ? (
        <p
          role="status"
          className={`rounded-md border px-3 py-2 text-sm ${
            ok
              ? "border-emerald-300 bg-emerald-50 text-emerald-900 dark:border-emerald-800 dark:bg-emerald-950 dark:text-emerald-100"
              : "border-amber-300 bg-amber-50 text-amber-900 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-100"
          }`}
        >
          {message}
        </p>
      ) : null}

      <form action={formAction} className="space-y-2">
        <label
          htmlFor="cover"
          className="block text-sm font-medium text-slate-700 dark:text-slate-300"
        >
          {hasCover ? "Replace cover" : "Upload cover"}
        </label>
        {/* A real file input. v2 read the file in the browser, JSON-encoded it
            into a hidden field, and posted it through a urlencoded body. */}
        <input
          id="cover"
          name="cover"
          type="file"
          accept="image/jpeg,image/png,image/webp,image/gif,image/avif"
          required
          className="block w-full text-sm file:mr-3 file:rounded-md file:border file:border-slate-300 file:bg-transparent file:px-3 file:py-1.5 file:text-sm file:font-medium dark:file:border-slate-700"
        />
        <p className="text-xs text-slate-500 dark:text-slate-400">
          JPEG, PNG, WebP, GIF, or AVIF, up to {MAX_UPLOAD_BYTES / 1024 / 1024}{" "}
          MB. Resized to fit 800×1200 and converted to WebP; EXIF is stripped.
        </p>
        <UploadSubmit />
      </form>

      {hasCover ? (
        <form action={removeAction}>
          <input type="hidden" name="bookId" value={bookId} />
          <RemoveSubmit />
        </form>
      ) : null}
    </div>
  );
}

function UploadSubmit() {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending}
      className="rounded-md bg-slate-900 px-3 py-1.5 text-sm font-medium text-white disabled:opacity-60 dark:bg-slate-100 dark:text-slate-900"
    >
      {pending ? "Uploading…" : "Upload"}
    </button>
  );
}

function RemoveSubmit() {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending}
      className="text-xs text-red-700 underline disabled:opacity-60 dark:text-red-400"
    >
      {pending ? "Removing…" : "Remove cover"}
    </button>
  );
}
