"use client";

import Link from "next/link";
import { useActionState } from "react";
import { useFormStatus } from "react-dom";

import type { ActionState } from "@/lib/catalogue/validation";

interface AuthorValues {
  name?: string;
  sortName?: string;
  bio?: string | null;
  birthYear?: number | null;
  deathYear?: number | null;
}

export function AuthorForm({
  action,
  values,
  submitLabel,
  cancelHref,
}: {
  action: (state: ActionState, formData: FormData) => Promise<ActionState>;
  values?: AuthorValues;
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
        label="Name"
        name="name"
        defaultValue={values?.name}
        error={error("name")}
        required
      />
      <Text
        label="Sort name"
        name="sortName"
        defaultValue={values?.sortName}
        error={error("sortName")}
        hint="Left blank, this is derived — “Ada Lovelace” becomes “Lovelace, Ada”."
      />

      <div className="grid grid-cols-2 gap-4">
        <Text
          label="Birth year"
          name="birthYear"
          type="number"
          defaultValue={values?.birthYear?.toString()}
          error={error("birthYear")}
        />
        <Text
          label="Death year"
          name="deathYear"
          type="number"
          defaultValue={values?.deathYear?.toString()}
          error={error("deathYear")}
        />
      </div>

      <div>
        <label
          htmlFor="bio"
          className="block text-sm font-medium text-slate-700 dark:text-slate-300"
        >
          Biography
        </label>
        <textarea
          id="bio"
          name="bio"
          rows={5}
          defaultValue={values?.bio ?? ""}
          className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm dark:border-slate-700 dark:bg-slate-900"
        />
        {error("bio") ? (
          <p
            role="alert"
            className="mt-1 text-xs text-red-700 dark:text-red-400"
          >
            {error("bio")}
          </p>
        ) : null}
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
