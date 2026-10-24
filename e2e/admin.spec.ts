import { expect, test } from "@playwright/test";

import { signIn } from "./helpers";

test("a member is refused the admin reports", async ({ page }) => {
  await signIn(page, "ada@myweblib.test");

  const response = await page.goto("/admin");

  expect(response?.status()).toBe(403);
  await expect(
    page.getByRole("heading", { level: 1, name: "Not allowed" }),
  ).toBeVisible();
  await expect(page.getByRole("link", { name: "Reports" })).toHaveCount(0);
});

test("an admin sees the reports page", async ({ page }) => {
  await signIn(page, "admin@myweblib.test");
  await page.getByRole("link", { name: "Reports" }).click();

  await expect(page).toHaveURL("/admin");
  await expect(
    page.getByRole("heading", { level: 1, name: "Reports" }),
  ).toBeVisible();
});
