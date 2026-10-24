import { expect, test } from "@playwright/test";

test("a signed-out visitor finds a book by title", async ({ page }) => {
  await page.goto("/books");

  await page
    .getByRole("searchbox", { name: "Search by title, author, or description" })
    .fill("Frankenstein");
  await page.getByRole("button", { name: "Search", exact: true }).click();

  await expect(page).toHaveURL(/[?&]q=Frankenstein/);
  await expect(
    page.getByRole("link", { name: "Frankenstein", exact: true }),
  ).toBeVisible();
});
