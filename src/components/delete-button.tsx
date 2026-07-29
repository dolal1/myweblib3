"use client";

import { useActionState } from "react";
import { useFormStatus } from "react-dom";

import type { ActionState } from "@/lib/catalogue/validation";

/**
 * Delete control that shows the database's refusal.
 *
 * This exists because of one specific v2 behaviour worth dwelling on: its
 * author delete route caught every error with a bare `catch` and redirected, so
 * when the `pre('remove')` hook refused ("This author has books still") the
 * user saw a page reload and nothing else. The refusal was invisible.
 *
 * Here the action returns a message and it is rendered next to the button.
 */
export function DeleteButton({
  action,
  id,
  label = "Delete",
  confirm,
}: {
  action: (state: ActionState, formData: FormData) => Promise<ActionState>;
  id: string;
  label?: string;
  confirm: string;
}) {
  const [state, formAction] = useActionState<ActionState, FormData>(action, {});

  return (
    <div>
      <form
        action={formAction}
        onSubmit={(event) => {
          if (!window.confirm(confirm)) event.preventDefault();
        }}
      >
        <input type="hidden" name="id" value={id} />
        <Submit label={label} />
      </form>

      {state.message ? (
        <p
          role="alert"
          className="mt-3 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-100"
        >
          {state.message}
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
      className="rounded-md border border-red-300 px-3 py-2 text-sm font-medium text-red-700 disabled:opacity-60 dark:border-red-900 dark:text-red-300"
    >
      {pending ? "Deleting…" : label}
    </button>
  );
}
