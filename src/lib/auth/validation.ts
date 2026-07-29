import { z } from "zod";

import { MAX_PASSWORD_BYTES } from "@/lib/auth/password";

/**
 * Credential validation, shared by the server actions and their forms.
 *
 * v2 hand-rolled this as a list of `if` statements that pushed strings onto an
 * errors array — and got it wrong twice over: it checked `password.length`
 * after only *pushing* an error for a missing password (a TypeError on
 * undefined), and it rendered the submitted password back into the form's
 * `value=` attribute on failure.
 */

export const emailSchema = z
  .string()
  .trim()
  .min(1, "Email is required")
  .max(254, "Email is too long") // RFC 5321 limit
  .pipe(z.email("Enter a valid email address"));

/**
 * A length floor and nothing else.
 *
 * Composition rules ("one uppercase, one symbol") push people towards
 * `Password1!` and are no longer recommended by NIST. Length is what matters,
 * and the upper bound exists only so nobody can make us hash a megabyte.
 */
export const passwordSchema = z
  .string()
  .min(12, "Use at least 12 characters")
  .max(MAX_PASSWORD_BYTES, "Password is too long");

export const registerSchema = z
  .object({
    name: z
      .string()
      .trim()
      .min(1, "Name is required")
      .max(120, "Name is too long"),
    email: emailSchema,
    password: passwordSchema,
    confirmPassword: z.string(),
  })
  .refine((data) => data.password === data.confirmPassword, {
    message: "Passwords do not match",
    path: ["confirmPassword"],
  });

export const loginSchema = z.object({
  email: emailSchema,
  // Deliberately not `passwordSchema`: applying the 12-character minimum at
  // login would tell an attacker that no account can have a shorter password,
  // and would lock out anyone whose password predates a policy change.
  password: z.string().min(1, "Password is required"),
});

export type RegisterInput = z.infer<typeof registerSchema>;
export type LoginInput = z.infer<typeof loginSchema>;

/** Shape returned by the auth actions to `useActionState`. */
export interface AuthFormState {
  /** Field-level messages, keyed by input name. */
  errors?: Record<string, string[]>;
  /** A single form-level message, e.g. "Invalid email or password". */
  message?: string;
  /**
   * Values to repopulate the form with. Note what is *absent*: passwords are
   * never echoed back, which is precisely what v2 did.
   */
  values?: { name?: string; email?: string };
}

/** Flattens a ZodError into the AuthFormState shape. */
export function toFormErrors(error: z.ZodError): Record<string, string[]> {
  const errors: Record<string, string[]> = {};
  for (const issue of error.issues) {
    const key = issue.path.join(".") || "form";
    (errors[key] ??= []).push(issue.message);
  }
  return errors;
}
