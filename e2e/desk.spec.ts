import { expect, test } from "@playwright/test";

import { signIn } from "./helpers";

// The second copy of Persuasion. The seed lends the first one to Brian and
// leaves this one on the shelf, and no other test touches it.
const BARCODE = "MWL-00007";

test("a librarian checks out a copy at the desk and it shows as on loan", async ({
  page,
}) => {
  await signIn(page, "librarian@myweblib.test");
  await page.getByRole("link", { name: "Desk" }).click();

  const checkOut = page
    .locator("section")
    .filter({ has: page.getByRole("heading", { name: "Check out" }) });
  await checkOut
    .getByLabel("Member")
    .selectOption({ label: "Chidi Balogun (chidi@myweblib.test)" });
  await checkOut.getByLabel("Barcode").fill(BARCODE);
  await checkOut.getByRole("button", { name: "Check out" }).click();
  await expect(checkOut.getByRole("status")).toContainText(
    `Checked out ${BARCODE}.`,
  );

  await page.goto("/books");
  await page.getByRole("link", { name: "Persuasion", exact: true }).click();
  await expect(
    page.getByRole("row", { name: new RegExp(BARCODE) }),
  ).toContainText("On loan");

  // Put the copy back, so a retry of this test starts from the seeded state.
  await page.goto("/desk");
  const giveBack = page
    .locator("section")
    .filter({ has: page.getByRole("heading", { name: "Return" }) });
  await giveBack.getByLabel("Barcode").fill(BARCODE);
  await giveBack.getByRole("button", { name: "Return" }).click();
  await expect(giveBack.getByRole("status")).toContainText(
    `Returned ${BARCODE}.`,
  );
});
