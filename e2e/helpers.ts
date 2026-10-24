import { expect, type Page } from "@playwright/test";

/** Every seeded account uses this password (prisma/seed.ts). */
export const DEMO_PASSWORD = "correct-horse-battery-staple";

/** Signs in through the real login form and waits for the redirect home. */
export async function signIn(page: Page, email: string): Promise<void> {
  await page.goto("/login");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(DEMO_PASSWORD);
  await page.getByRole("button", { name: "Log in" }).click();
  await expect(page).toHaveURL("/");
  await expect(
    page.getByRole("navigation").getByRole("button", { name: "Log out" }),
  ).toBeVisible();
}
