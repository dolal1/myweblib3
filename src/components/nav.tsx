import Link from "next/link";

import { logout } from "@/app/actions/auth";
import { getCurrentUser, hasRole } from "@/lib/auth/dal";

/**
 * Site navigation.
 *
 * Unlike v2's navbar — which had a permanent "Disabled" placeholder link, a
 * stray closing div, and no idea whether anyone was logged in — this reflects
 * the session and the viewer's role.
 *
 * Hiding a link is presentation, not protection: the staff routes are guarded
 * by requireRole in the page and again in every action.
 */
export async function Nav() {
  const user = await getCurrentUser();
  const isStaff = hasRole(user, "LIBRARIAN");

  return (
    <header className="border-b border-slate-200 dark:border-slate-800">
      <nav className="mx-auto flex max-w-3xl flex-wrap items-center gap-x-6 gap-y-2 px-6 py-3 text-sm">
        <Link href="/" className="font-semibold">
          myweblib3
        </Link>

        <Link href="/books" className="hover:underline">
          Books
        </Link>
        <Link href="/authors" className="hover:underline">
          Authors
        </Link>

        {user ? (
          <Link href="/account" className="hover:underline">
            My account
          </Link>
        ) : null}
        {isStaff ? (
          <Link href="/desk" className="hover:underline">
            Desk
          </Link>
        ) : null}
        {hasRole(user, "ADMIN") ? (
          <Link href="/admin" className="hover:underline">
            Reports
          </Link>
        ) : null}

        <div className="ml-auto flex items-center gap-4">
          {isStaff ? (
            <span className="rounded bg-slate-100 px-1.5 py-0.5 text-xs font-medium text-slate-600 uppercase dark:bg-slate-800 dark:text-slate-300">
              {user?.role.toLowerCase()}
            </span>
          ) : null}

          {user ? (
            <>
              <span className="text-slate-600 dark:text-slate-400">
                {user.name}
              </span>
              <form action={logout}>
                <button type="submit" className="font-medium hover:underline">
                  Log out
                </button>
              </form>
            </>
          ) : (
            <>
              <Link href="/login" className="font-medium hover:underline">
                Log in
              </Link>
              <Link href="/register" className="font-medium hover:underline">
                Register
              </Link>
            </>
          )}
        </div>
      </nav>
    </header>
  );
}
