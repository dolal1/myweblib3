import { expect, test } from "@playwright/test";

test("a wrong password shows an error and does not sign in", async ({
  page,
}) => {
  await page.goto("/login");
  await page.getByLabel("Email").fill("ada@myweblib.test");
  await page.getByLabel("Password").fill("not-the-password");
  await page.getByRole("button", { name: "Log in" }).click();

  // Not a bare getByRole("alert"): Next's route announcer is an alert too.
  await expect(
    page.getByRole("alert").filter({ hasText: "Invalid email or password" }),
  ).toBeVisible();
  await expect(page).toHaveURL("/login");
  await expect(
    page.getByRole("navigation").getByRole("link", { name: "Log in" }),
  ).toBeVisible();
});
