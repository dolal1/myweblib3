import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";

import { register } from "@/app/actions/auth";
import { AuthForm, Field, SubmitButton } from "@/components/auth-form";
import { getCurrentUser } from "@/lib/auth/dal";

export const metadata: Metadata = { title: "Register" };

export default async function RegisterPage() {
  if (await getCurrentUser()) redirect("/");

  return (
    <main className="mx-auto max-w-sm px-6 py-16">
      <h1 className="text-2xl font-semibold tracking-tight">Register</h1>

      <AuthForm action={register} className="mt-8">
        <Field label="Name" name="name" autoComplete="name" required />
        <Field
          label="Email"
          name="email"
          type="email"
          autoComplete="email"
          required
        />
        <Field
          label="Password"
          name="password"
          type="password"
          autoComplete="new-password"
          hint="At least 12 characters."
          required
        />
        <Field
          label="Confirm password"
          name="confirmPassword"
          type="password"
          autoComplete="new-password"
          required
        />
        <SubmitButton idle="Create account" pending="Creating account…" />
      </AuthForm>

      <p className="mt-6 text-sm text-slate-600 dark:text-slate-400">
        Already have an account?{" "}
        <Link href="/login" className="font-medium underline">
          Log in
        </Link>
      </p>
    </main>
  );
}
