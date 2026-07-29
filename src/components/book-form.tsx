"use client";

import Link from "next/link";
import { useActionState } from "react";
import { useFormStatus } from "react-dom";

import type { ActionState } from "@/lib/catalogue/validation";

interface Option {
  id: string;
  name: string;
}

interface BookValues {
  title?: string;
  subtitle?: string | null;
  isbn13?: string | null;
  description?: string | null;
  publisher?: string | null;
  language?: string;
  pageCount?: number | null;
  publishedOn?: Date | null;
  authorIds?: string[];
  genreIds?: string[];
}

export function BookForm({
  action,
  authors,
  genres,
  values,
  submitLabel,
  cancelHref,
}: {
  action: (state: ActionState, formData: FormData) => Promise<ActionState>;
  authors: Option[];
  genres: Option[];
  values?: BookValues;
  submitLabel: string;
  cancelHref: string;
}) {
  const [state, formAction] = useActionState<ActionState, FormData>(action, {});
  const error = (field: string) => state.errors?.[field]?.join(". ");

  return (
    <form action={formAction} className="space-y-4" noValidate>
      {state.message ? (
        <p
          role="alert"
          className="rounded-md border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-800 dark:border-red-900 dark:bg-red-950 dark:text-red-200"
        >
          {state.message}
        </p>
      ) : null}

      <Text
        label="Title"
        name="title"
        defaultValue={values?.title}
        error={error("title")}
        required
      />
      <Text
        label="Subtitle"
        name="subtitle"
        defaultValue={values?.subtitle ?? ""}
        error={error("subtitle")}
      />

      {/* Multiple selection is the point: v2's Book.author was a single
          ObjectId, so a co-authored book could not be recorded. */}
      <MultiSelect
        label="Authors"
        name="authorIds"
        options={authors}
        selected={values?.authorIds ?? []}
        error={error("authorIds")}
        hint="Hold Ctrl or Cmd to credit more than one person."
      />

      <MultiSelect
        label="Genres"
        name="genreIds"
        options={genres}
        selected={values?.genreIds ?? []}
        error={error("genreIds")}
      />

      <div className="grid grid-cols-2 gap-4">
        <Text
          label="ISBN"
          name="isbn13"
          defaultValue={values?.isbn13 ?? ""}
          error={error("isbn13")}
          hint="ISBN-10 or 13, hyphens fine. The check digit is verified."
        />
        <Text
          label="Published on"
          name="publishedOn"
          type="date"
          defaultValue={values?.publishedOn?.toISOString().slice(0, 10) ?? ""}
          error={error("publishedOn")}
        />
      </div>

      <div className="grid grid-cols-3 gap-4">
        <Text
          label="Publisher"
          name="publisher"
          defaultValue={values?.publisher ?? ""}
          error={error("publisher")}
        />
        <Text
          label="Pages"
          name="pageCount"
          type="number"
          min="1"
          defaultValue={values?.pageCount?.toString() ?? ""}
          error={error("pageCount")}
        />
        <Text
          label="Language"
          name="language"
          defaultValue={values?.language ?? "en"}
          error={error("language")}
        />
      </div>

      <div>
        <label
          htmlFor="description"
          className="block text-sm font-medium text-slate-700 dark:text-slate-300"
        >
          Description
        </label>
        <textarea
          id="description"
          name="description"
          rows={5}
          defaultValue={values?.description ?? ""}
          className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm dark:border-slate-700 dark:bg-slate-900"
        />
      </div>

      <div className="flex items-center gap-3 pt-2">
        <Submit label={submitLabel} />
        <Link href={cancelHref} className="text-sm underline">
          Cancel
        </Link>
      </div>
    </form>
  );
}

function MultiSelect({
  label,
  name,
  options,
  selected,
  error,
  hint,
}: {
  label: string;
  name: string;
  options: Option[];
  selected: string[];
  error?: string | undefined;
  hint?: string;
}) {
  return (
    <div>
      <label
        htmlFor={name}
        className="block text-sm font-medium text-slate-700 dark:text-slate-300"
      >
        {label}
      </label>
      <select
        id={name}
        name={name}
        multiple
        size={Math.min(6, Math.max(3, options.length))}
        defaultValue={selected}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? `${name}-error` : undefined}
        className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm dark:border-slate-700 dark:bg-slate-900"
      >
        {options.map((option) => (
          <option key={option.id} value={option.id}>
            {option.name}
          </option>
        ))}
      </select>
      {hint ? (
        <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
          {hint}
        </p>
      ) : null}
      {error ? (
        <p
          id={`${name}-error`}
          role="alert"
          className="mt-1 text-xs text-red-700 dark:text-red-400"
        >
          {error}
        </p>
      ) : null}
    </div>
  );
}

function Text({
  label,
  name,
  error,
  hint,
  ...rest
}: {
  label: string;
  name: string;
  error?: string | undefined;
  hint?: string;
} & React.InputHTMLAttributes<HTMLInputElement>) {
  return (
    <div>
      <label
        htmlFor={name}
        className="block text-sm font-medium text-slate-700 dark:text-slate-300"
      >
        {label}
      </label>
      <input
        id={name}
        name={name}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? `${name}-error` : undefined}
        className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm dark:border-slate-700 dark:bg-slate-900"
        {...rest}
      />
      {hint ? (
        <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
          {hint}
        </p>
      ) : null}
      {error ? (
        <p
          id={`${name}-error`}
          role="alert"
          className="mt-1 text-xs text-red-700 dark:text-red-400"
        >
          {error}
        </p>
      ) : null}
    </div>
  );
}

function Submit({ label }: { label: string }) {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending}
      className="rounded-md bg-slate-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-60 dark:bg-slate-100 dark:text-slate-900"
    >
      {pending ? "Saving…" : label}
    </button>
  );
}
