"use client";

import { createContext, use, useActionState } from "react";
import { useFormStatus } from "react-dom";

import type { AuthFormState } from "@/lib/auth/validation";

/**
 * Shared form shell for login and register.
 *
 * Progressive enhancement is the default here: the `<form action={...}>` posts
 * and works with JavaScript disabled, and `useActionState` layers the pending
 * state and inline errors on top once hydrated.
 */

const StateContext = createContext<AuthFormState>({});

type ActionFn = (
  state: AuthFormState,
  formData: FormData,
) => Promise<AuthFormState>;

export function AuthForm({
  action,
  className,
  children,
}: {
  action: ActionFn;
  className?: string;
  children: React.ReactNode;
}) {
  const [state, formAction] = useActionState<AuthFormState, FormData>(
    action,
    {},
  );

  return (
    <StateContext value={state}>
      <form action={formAction} className={className} noValidate>
        {state.message ? (
          <p
            role="alert"
            className="mb-4 rounded-md border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-800 dark:border-red-900 dark:bg-red-950 dark:text-red-200"
          >
            {state.message}
          </p>
        ) : null}
        <div className="space-y-4">{children}</div>
      </form>
    </StateContext>
  );
}

export function Field({
  label,
  name,
  type = "text",
  hint,
  ...rest
}: {
  label: string;
  name: string;
  type?: string;
  hint?: string;
} & React.InputHTMLAttributes<HTMLInputElement>) {
  const state = use(StateContext);
  const errors = state.errors?.[name];
  const errorId = `${name}-error`;
  const hintId = `${name}-hint`;

  // Only non-secret fields are ever repopulated. `values` deliberately has no
  // password key — see the note in lib/auth/validation.ts.
  const defaultValue =
    name === "name" || name === "email"
      ? (state.values?.[name] ?? "")
      : undefined;

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
        type={type}
        defaultValue={defaultValue}
        aria-invalid={errors ? true : undefined}
        aria-describedby={
          [errors ? errorId : null, hint ? hintId : null]
            .filter(Boolean)
            .join(" ") || undefined
        }
        className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm outline-none focus:border-slate-900 focus:ring-1 focus:ring-slate-900 dark:border-slate-700 dark:bg-slate-900 dark:focus:border-slate-100 dark:focus:ring-slate-100"
        {...rest}
      />
      {hint ? (
        <p
          id={hintId}
          className="mt-1 text-xs text-slate-500 dark:text-slate-400"
        >
          {hint}
        </p>
      ) : null}
      {errors ? (
        <p
          id={errorId}
          role="alert"
          className="mt-1 text-xs text-red-700 dark:text-red-400"
        >
          {errors.join(". ")}
        </p>
      ) : null}
    </div>
  );
}

export function SubmitButton({
  idle,
  pending: pendingLabel,
}: {
  idle: string;
  pending: string;
}) {
  const { pending } = useFormStatus();

  return (
    <button
      type="submit"
      disabled={pending}
      className="w-full rounded-md bg-slate-900 px-3 py-2 text-sm font-medium text-white disabled:opacity-60 dark:bg-slate-100 dark:text-slate-900"
    >
      {pending ? pendingLabel : idle}
    </button>
  );
}
