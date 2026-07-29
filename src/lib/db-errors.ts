/**
 * Prisma error discrimination.
 *
 * The database is the authority on integrity, so the application's job is to
 * translate its refusals into sentences a user can act on. That is the whole
 * difference between v3 and myweblib2, where every failure funnelled into
 * `catch { res.redirect('/') }` and the user saw a silent no-op.
 *
 * ## Why this reads the SQLSTATE and not just the Prisma code
 *
 * Prisma 7 talks to Postgres through a driver adapter, and that changed how
 * constraint violations surface. A `RESTRICT` violation does **not** arrive as
 * the documented `P2003` ("Foreign key constraint failed"). It arrives as:
 *
 *   code: "P2039"
 *   meta.driverAdapterError.cause.code: "23001"
 *
 * where 23001 is the Postgres SQLSTATE for `restrict_violation`. An earlier
 * version of this file checked only for P2003/P2014, so it silently failed to
 * recognise the very refusal the schema was designed around — reproducing v2's
 * bug in a new form. The integration tests in
 * tests/catalogue-integrity.integration.test.ts exist to catch exactly that.
 *
 * So: check the SQLSTATE first, because it is what Postgres actually said, and
 * fall back to Prisma's codes for setups that do not use a driver adapter.
 *
 * SQLSTATE class 23 — integrity constraint violation:
 *   23001 restrict_violation
 *   23502 not_null_violation
 *   23503 foreign_key_violation
 *   23505 unique_violation
 *   23514 check_violation
 */

function prismaErrorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  if (!("code" in error)) return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}

/** Digs the underlying Postgres SQLSTATE out of a driver-adapter error. */
export function sqlState(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null) return undefined;

  const meta = (error as { meta?: unknown }).meta;
  if (typeof meta !== "object" || meta === null) return undefined;

  const adapterError = (meta as { driverAdapterError?: unknown })
    .driverAdapterError;
  if (typeof adapterError !== "object" || adapterError === null) {
    return undefined;
  }

  const cause = (adapterError as { cause?: unknown }).cause;
  if (typeof cause !== "object" || cause === null) return undefined;

  const code = (cause as { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}

/** The raw Postgres message, which carries the constraint name. */
function driverMessage(error: unknown): string {
  const parts: string[] = [];

  if (typeof error === "object" && error !== null) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === "string") parts.push(message);

    const meta = (error as { meta?: unknown }).meta;
    if (typeof meta === "object" && meta !== null) {
      const adapterError = (meta as { driverAdapterError?: unknown })
        .driverAdapterError;
      if (typeof adapterError === "object" && adapterError !== null) {
        const cause = (adapterError as { cause?: unknown }).cause;
        if (typeof cause === "object" && cause !== null) {
          for (const key of ["message", "originalMessage", "detail"] as const) {
            const value = (cause as Record<string, unknown>)[key];
            if (typeof value === "string") parts.push(value);
          }
        }
      }
    }
  }

  return parts.join("\n");
}

/** Unique constraint failed. */
export function isUniqueViolation(error: unknown): boolean {
  return prismaErrorCode(error) === "P2002" || sqlState(error) === "23505";
}

/**
 * Something still references the row being deleted or updated.
 *
 * Covers both `RESTRICT` (23001) and plain foreign key violations (23503), plus
 * Prisma's own P2003/P2014 for non-adapter setups.
 */
export function isForeignKeyViolation(error: unknown): boolean {
  const state = sqlState(error);
  if (state === "23001" || state === "23503") return true;

  const code = prismaErrorCode(error);
  return code === "P2003" || code === "P2014";
}

/** The record required for the operation was not found. */
export function isNotFound(error: unknown): boolean {
  return prismaErrorCode(error) === "P2025";
}

/**
 * A check constraint rejected the row; returns the constraint name.
 *
 * Useful both for a targeted message and in logs — reaching one of these means
 * validation upstream let something through that it should have caught.
 */
export function violatedCheckConstraint(error: unknown): string | undefined {
  if (sqlState(error) !== undefined && sqlState(error) !== "23514") {
    // Definitely a database error, but not a check violation.
    return undefined;
  }
  const match = /violates check constraint "([^"]+)"/.exec(
    driverMessage(error),
  );
  return match?.[1];
}

/** The name of any violated constraint, whatever its kind. */
export function violatedConstraint(error: unknown): string | undefined {
  const message = driverMessage(error);
  const match =
    /violates (?:check|foreign key|unique) constraint "([^"]+)"/.exec(
      message,
    ) ??
    /violates RESTRICT setting of foreign key constraint "([^"]+)"/.exec(
      message,
    ) ??
    /Unique constraint failed on the fields: \(`([^`]+)`\)/.exec(message);
  return match?.[1];
}
