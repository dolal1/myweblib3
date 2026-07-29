import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";

import { login } from "@/app/actions/auth";
import { AuthForm, Field, SubmitButton } from "@/components/auth-form";
import { getCurrentUser } from "@/lib/auth/dal";

export const metadata: Metadata = { title: "Log in" };

export default async function LoginPage() {
  if (await getCurrentUser()) redirect("/");

  return (
    <main className="mx-auto max-w-sm px-6 py-16">
      <h1 className="text-2xl font-semibold tracking-tight">Log in</h1>

      <AuthForm action={login} className="mt-8">
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
          autoComplete="current-password"
          required
        />
        <SubmitButton idle="Log in" pending="Logging in…" />
      </AuthForm>

      <p className="mt-6 text-sm text-slate-600 dark:text-slate-400">
        No account?{" "}
        <Link href="/register" className="font-medium underline">
          Register
        </Link>
      </p>
    </main>
  );
}
