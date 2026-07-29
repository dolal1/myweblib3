"use client";

import { useEffect, useRef } from "react";
import { useActionState } from "react";
import { useFormStatus } from "react-dom";

import type { DeskState } from "@/app/actions/circulation";

type Action = (state: DeskState, formData: FormData) => Promise<DeskState>;

/**
 * Circulation desk form.
 *
 * The barcode field keeps focus and clears on success, because the real-world
 * use is a librarian with a scanner working through a trolley of returns — one
 * beep per item, no mouse.
 */
export function DeskForm({
  action,
  title,
  description,
  members,
  submitLabel,
}: {
  action: Action;
  title: string;
  description: string;
  members?: { id: string; name: string; email: string }[];
  submitLabel: string;
}) {
  const [state, formAction] = useActionState<DeskState, FormData>(action, {});
  const barcodeRef = useRef<HTMLInputElement>(null);

  // Clear and refocus the barcode field after a successful scan. Doing this in
  // an effect rather than with a randomised `key` keeps render pure — eslint's
  // react-hooks/purity rule rejects Math.random() during render, and it is
  // right to: a value that differs between server and client render is a
  // hydration mismatch by construction.
  useEffect(() => {
    if (state.ok && barcodeRef.current) {
      barcodeRef.current.value = "";
      barcodeRef.current.focus();
    }
  }, [state]);

  return (
    <section className="rounded-lg border border-slate-200 p-5 dark:border-slate-800">
      <h2 className="font-semibold">{title}</h2>
      <p className="mt-1 mb-4 text-sm text-slate-600 dark:text-slate-400">
        {description}
      </p>

      {state.message ? (
        <p
          role="status"
          aria-live="polite"
          className={`mb-4 rounded-md border px-3 py-2 text-sm ${
            state.ok
              ? "border-emerald-300 bg-emerald-50 text-emerald-900 dark:border-emerald-800 dark:bg-emerald-950 dark:text-emerald-100"
              : "border-amber-300 bg-amber-50 text-amber-900 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-100"
          }`}
        >
          {state.message}
          {state.detail ? (
            <span className="mt-1 block opacity-80">{state.detail}</span>
          ) : null}
        </p>
      ) : null}

      <form action={formAction} className="space-y-3">
        {members ? (
          <div>
            <label
              htmlFor={`${title}-member`}
              className="block text-sm font-medium text-slate-700 dark:text-slate-300"
            >
              Member
            </label>
            <select
              id={`${title}-member`}
              name="memberId"
              required
              className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm dark:border-slate-700 dark:bg-slate-900"
            >
              <option value="">Choose a member…</option>
              {members.map((member) => (
                <option key={member.id} value={member.id}>
                  {member.name} ({member.email})
                </option>
              ))}
            </select>
          </div>
        ) : null}

        <div>
          <label
            htmlFor={`${title}-barcode`}
            className="block text-sm font-medium text-slate-700 dark:text-slate-300"
          >
            Barcode
          </label>
          <input
            ref={barcodeRef}
            id={`${title}-barcode`}
            name="barcode"
            required
            autoComplete="off"
            placeholder="MWL-00001"
            className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 font-mono text-sm dark:border-slate-700 dark:bg-slate-900"
          />
        </div>

        <Submit label={submitLabel} />
      </form>
    </section>
  );
}

function Submit({ label }: { label: string }) {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending}
      className="w-full rounded-md bg-slate-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-60 dark:bg-slate-100 dark:text-slate-900"
    >
      {pending ? "Working…" : label}
    </button>
  );
}

/** Single-button action form used for renew, cancel hold, and pay fine. */
export function ActionButton({
  action,
  name,
  value,
  label,
  variant = "secondary",
}: {
  action: Action;
  name: string;
  value: string;
  label: string;
  variant?: "primary" | "secondary";
}) {
  const [state, formAction] = useActionState<DeskState, FormData>(action, {});

  return (
    <span className="inline-flex flex-col items-start gap-1">
      <form action={formAction}>
        <input type="hidden" name={name} value={value} />
        <InlineSubmit label={label} variant={variant} />
      </form>
      {state.message ? (
        <span
          role="status"
          className={`text-xs ${
            state.ok
              ? "text-emerald-700 dark:text-emerald-400"
              : "text-amber-700 dark:text-amber-400"
          }`}
        >
          {state.message}
        </span>
      ) : null}
    </span>
  );
}

function InlineSubmit({
  label,
  variant,
}: {
  label: string;
  variant: "primary" | "secondary";
}) {
  const { pending } = useFormStatus();
  const tone =
    variant === "primary"
      ? "bg-slate-900 text-white dark:bg-slate-100 dark:text-slate-900"
      : "border border-slate-300 dark:border-slate-700";

  return (
    <button
      type="submit"
      disabled={pending}
      className={`rounded-md px-2.5 py-1 text-xs font-medium disabled:opacity-60 ${tone}`}
    >
      {pending ? "…" : label}
    </button>
  );
}
