import { expect, test } from "@playwright/test";

import { signIn } from "./helpers";

test("a member sees their active loans on the account page", async ({
  page,
}) => {
  await signIn(page, "ada@myweblib.test");
  await page.getByRole("link", { name: "My account" }).click();

  await expect(
    page.getByRole("heading", { level: 1, name: "My account" }),
  ).toBeVisible();

  const onLoan = page
    .locator("section")
    .filter({ has: page.getByRole("heading", { name: "On loan" }) });
  await expect(onLoan.getByRole("listitem")).toHaveCount(2);
  await expect(
    onLoan.getByRole("link", { name: "Frankenstein", exact: true }),
  ).toBeVisible();
  await expect(
    onLoan.getByRole("link", { name: "Sketch of the Analytical Engine" }),
  ).toBeVisible();
});
