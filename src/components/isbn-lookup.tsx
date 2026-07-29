"use client";

import Link from "next/link";
import { useActionState } from "react";
import { useFormStatus } from "react-dom";

import { lookupIsbnAction, type LookupState } from "@/app/actions/isbn-lookup";
import { BookForm } from "@/components/book-form";
import type { ActionState } from "@/lib/catalogue/validation";

interface Option {
  id: string;
  name: string;
}

/**
 * ISBN lookup wrapped around the book form.
 *
 * Two separate forms, deliberately: the lookup is its own submission, and its
 * result seeds the real form's defaults. That keeps progressive enhancement
 * intact — with JavaScript off, the lookup form still posts and the book form
 * still renders prefilled.
 */
export function IsbnLookup({
  createAction,
  authors,
  genres,
}: {
  createAction: (
    state: ActionState,
    formData: FormData,
  ) => Promise<ActionState>;
  authors: Option[];
  genres: Option[];
}) {
  const [state, lookupAction] = useActionState<LookupState, FormData>(
    lookupIsbnAction,
    {},
  );

  const prefill = state.prefill;

  return (
    <>
      <section className="mb-8 rounded-lg border border-slate-200 p-4 dark:border-slate-800">
        <h2 className="text-sm font-semibold">Look up by ISBN</h2>
        <p className="mt-1 mb-3 text-xs text-slate-500 dark:text-slate-400">
          Fetches title, authors, publisher, and page count from Open Library.
          Optional — everything can be typed in below.
        </p>

        <form action={lookupAction} className="flex gap-2">
          <input
            name="isbn"
            placeholder="978-0-14-143947-1"
            aria-label="ISBN to look up"
            className="w-full rounded-md border border-slate-300 px-3 py-2 font-mono text-sm dark:border-slate-700 dark:bg-slate-900"
          />
          <LookupSubmit />
        </form>

        {state.message ? (
          <p
            role="status"
            className="mt-3 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-100"
          >
            {state.message}
            {state.duplicateOfId ? (
              <>
                {" "}
                <Link
                  href={`/books/${state.duplicateOfId}`}
                  className="font-medium underline"
                >
                  View it
                </Link>
                .
              </>
            ) : null}
          </p>
        ) : null}

        {prefill ? (
          <div className="mt-3 rounded-md border border-emerald-300 bg-emerald-50 px-3 py-2 text-sm text-emerald-900 dark:border-emerald-800 dark:bg-emerald-950 dark:text-emerald-100">
            <p>
              Found <strong>{prefill.title}</strong>
              {prefill.authorNames.length > 0
                ? ` by ${prefill.authorNames.join(", ")}`
                : ""}
              . The form below has been filled in — check it before saving.
            </p>
            {prefill.unknownAuthorNames.length > 0 ? (
              <p className="mt-2">
                Not yet in the catalogue:{" "}
                <strong>{prefill.unknownAuthorNames.join(", ")}</strong>.{" "}
                <Link href="/authors/new" className="underline">
                  Add the author
                </Link>{" "}
                first, then look the ISBN up again.
              </p>
            ) : null}
          </div>
        ) : null}
      </section>

      <BookForm
        // Remounts when a lookup succeeds, so the new defaults take effect.
        key={prefill?.isbn13 ?? "blank"}
        action={createAction}
        authors={authors}
        genres={genres}
        {...(prefill
          ? {
              values: {
                title: prefill.title,
                subtitle: prefill.subtitle ?? null,
                isbn13: prefill.isbn13,
                publisher: prefill.publisher ?? null,
                pageCount: prefill.pageCount ?? null,
                publishedOn: prefill.publishedOn
                  ? new Date(`${prefill.publishedOn}T00:00:00Z`)
                  : null,
                authorIds: prefill.matchedAuthorIds,
              },
            }
          : {})}
        submitLabel="Create book"
        cancelHref="/books"
      />
    </>
  );
}

function LookupSubmit() {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending}
      className="shrink-0 rounded-md border border-slate-300 px-3 py-2 text-sm font-medium disabled:opacity-60 dark:border-slate-700"
    >
      {pending ? "Looking up…" : "Look up"}
    </button>
  );
}
