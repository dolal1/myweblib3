/**
 * Seeds a small but realistic library.
 *
 * The point is not volume, it is *shape*: the seeded data deliberately
 * contains every state the circulation code has to deal with — an available
 * copy, a copy on loan, an overdue loan with a fine, a returned loan, a hold
 * queue two deep, a co-authored book, a book with no cover, and a suspended
 * member. Tests and the demo both lean on this.
 *
 * Run with `npm run db:seed`. Idempotent: it clears the tables it owns first,
 * so it can be run repeatedly without piling up duplicates.
 */
import "dotenv/config";

import { PrismaPg } from "@prisma/adapter-pg";

import { PrismaClient } from "../src/generated/prisma/client.js";
import { hashPassword, normalizeEmail } from "../src/lib/auth/password.js";

const connectionString = process.env["DATABASE_URL"];
if (!connectionString) {
  throw new Error("DATABASE_URL is not set. Copy .env.example to .env.");
}

// The seed builds its own client rather than importing src/lib/db.ts, which is
// marked `server-only` and would throw under plain Node.
const db = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });

const DAY = 24 * 60 * 60 * 1000;
const now = Date.now();
const daysFromNow = (n: number) => new Date(now + n * DAY);

/** Every seeded account uses this password. Demo only, obviously. */
const DEMO_PASSWORD = "correct-horse-battery-staple";

async function clear() {
  // Order matters: children before parents, because the schema uses Restrict
  // rather than Cascade in the places where silent cascading would be wrong.
  await db.notification.deleteMany();
  await db.fine.deleteMany();
  await db.loan.deleteMany();
  await db.hold.deleteMany();
  await db.cover.deleteMany();
  await db.bookCopy.deleteMany();
  await db.bookAuthor.deleteMany();
  await db.book.deleteMany();
  await db.author.deleteMany();
  await db.genre.deleteMany();
  await db.session.deleteMany();
  await db.user.deleteMany();
}

async function main() {
  console.log("Clearing existing data…");
  await clear();

  const passwordHash = await hashPassword(DEMO_PASSWORD);

  console.log("Creating users…");
  const [admin, librarian, ada, brian, chidi, dana] = await Promise.all(
    (
      [
        ["admin@myweblib.test", "Amara Okonkwo", "ADMIN"],
        ["librarian@myweblib.test", "Lena Fischer", "LIBRARIAN"],
        ["ada@myweblib.test", "Ada Nwosu", "MEMBER"],
        ["brian@myweblib.test", "Brian Kimani", "MEMBER"],
        ["chidi@myweblib.test", "Chidi Balogun", "MEMBER"],
        ["dana@myweblib.test", "Dana Petrova", "MEMBER"],
      ] as const
    ).map(([email, name, role]) =>
      db.user.create({
        data: {
          email: normalizeEmail(email),
          name,
          role,
          passwordHash,
          // Dana owes money and is suspended, so the checkout path has a
          // blocked member to refuse.
          suspended: email.startsWith("dana"),
        },
      }),
    ),
  );

  if (!admin || !librarian || !ada || !brian || !chidi || !dana) {
    throw new Error("User seeding did not produce the expected six accounts.");
  }

  console.log("Creating genres…");
  const genreData = [
    ["Fiction", "fiction"],
    ["Science Fiction", "science-fiction"],
    ["History", "history"],
    ["Computing", "computing"],
    ["Poetry", "poetry"],
  ] as const;

  const genres = Object.fromEntries(
    await Promise.all(
      genreData.map(async ([name, slug]) => {
        const genre = await db.genre.create({ data: { name, slug } });
        return [slug, genre] as const;
      }),
    ),
  );

  console.log("Creating authors…");
  const authorData = [
    ["Ada Lovelace", "Lovelace, Ada", 1815, 1852],
    ["Mary Shelley", "Shelley, Mary", 1797, 1851],
    ["Charles Babbage", "Babbage, Charles", 1791, 1871],
    ["Jane Austen", "Austen, Jane", 1775, 1817],
    ["Frederick Douglass", "Douglass, Frederick", 1818, 1895],
    ["Christine de Pizan", "Pizan, Christine de", 1364, 1430],
  ] as const;

  const authors = Object.fromEntries(
    await Promise.all(
      authorData.map(async ([name, sortName, birthYear, deathYear]) => {
        const author = await db.author.create({
          data: { name, sortName, birthYear, deathYear },
        });
        return [name, author] as const;
      }),
    ),
  );

  const authorId = (name: string): string => {
    const author = authors[name];
    if (!author) throw new Error(`Seed bug: unknown author ${name}`);
    return author.id;
  };

  const genreId = (slug: string): string => {
    const genre = genres[slug];
    if (!genre) throw new Error(`Seed bug: unknown genre ${slug}`);
    return genre.id;
  };

  console.log("Creating books…");

  // Note the co-authored entry: this is the record v2's single-ObjectId
  // `Book.author` field could not represent at all.
  const notesOnTheEngine = await db.book.create({
    data: {
      title: "Sketch of the Analytical Engine",
      subtitle: "With Notes by the Translator",
      isbn13: "9780000000017",
      description:
        "Menabrea's account of Babbage's Analytical Engine, together with " +
        "Lovelace's notes — including Note G, the first published algorithm " +
        "intended for a machine.",
      publisher: "Taylor & Francis",
      publishedOn: new Date("1843-01-01"),
      pageCount: 92,
      genres: { connect: [{ id: genreId("computing") }] },
      authors: {
        create: [
          { authorId: authorId("Ada Lovelace"), role: "AUTHOR", position: 0 },
          {
            authorId: authorId("Charles Babbage"),
            role: "AUTHOR",
            position: 1,
          },
        ],
      },
    },
  });

  const frankenstein = await db.book.create({
    data: {
      title: "Frankenstein",
      subtitle: "or, The Modern Prometheus",
      isbn13: "9780000000024",
      description:
        "Victor Frankenstein assembles a living creature and abandons it. " +
        "Widely read as the first science fiction novel.",
      publisher: "Lackington, Hughes, Harding, Mavor & Jones",
      publishedOn: new Date("1818-01-01"),
      pageCount: 280,
      genres: {
        connect: [
          { id: genreId("fiction") },
          { id: genreId("science-fiction") },
        ],
      },
      authors: {
        create: [{ authorId: authorId("Mary Shelley"), role: "AUTHOR" }],
      },
    },
  });

  const persuasion = await db.book.create({
    data: {
      title: "Persuasion",
      isbn13: "9780000000031",
      description:
        "Anne Elliot, persuaded years earlier to refuse the man she loved, " +
        "meets him again with his fortune made.",
      publisher: "John Murray",
      publishedOn: new Date("1817-12-20"),
      pageCount: 249,
      genres: { connect: [{ id: genreId("fiction") }] },
      authors: {
        create: [{ authorId: authorId("Jane Austen"), role: "AUTHOR" }],
      },
    },
  });

  const narrative = await db.book.create({
    data: {
      title: "Narrative of the Life of Frederick Douglass",
      subtitle: "An American Slave",
      isbn13: "9780000000048",
      description:
        "Douglass's account of his enslavement, his self-education, and his " +
        "escape to freedom.",
      publisher: "Anti-Slavery Office",
      publishedOn: new Date("1845-05-01"),
      pageCount: 125,
      genres: { connect: [{ id: genreId("history") }] },
      authors: {
        create: [{ authorId: authorId("Frederick Douglass"), role: "AUTHOR" }],
      },
    },
  });

  // Deliberately has no ISBN and no cover, so the UI has to cope with both.
  const cityOfLadies = await db.book.create({
    data: {
      title: "The Book of the City of Ladies",
      description:
        "An allegorical city built and populated by women of history, " +
        "written in answer to the misogyny of its day.",
      publishedOn: new Date("1405-01-01"),
      pageCount: 281,
      language: "fr",
      genres: { connect: [{ id: genreId("history") }] },
      authors: {
        create: [{ authorId: authorId("Christine de Pizan"), role: "AUTHOR" }],
      },
    },
  });

  console.log("Creating copies…");
  const copiesByBook = [
    [notesOnTheEngine, 2],
    [frankenstein, 3],
    [persuasion, 2],
    [narrative, 1],
    [cityOfLadies, 1],
  ] as const;

  const copies: { id: string; barcode: string; bookId: string }[] = [];
  let barcodeSeq = 1;

  for (const [book, count] of copiesByBook) {
    for (let i = 0; i < count; i += 1) {
      const copy = await db.bookCopy.create({
        data: {
          barcode: `MWL-${String(barcodeSeq).padStart(5, "0")}`,
          bookId: book.id,
          shelfLocation: `${String.fromCharCode(65 + (barcodeSeq % 6))}-${
            (barcodeSeq % 20) + 1
          }`,
        },
      });
      copies.push(copy);
      barcodeSeq += 1;
    }
  }

  const copyFor = (bookId: string, nth = 0): { id: string } => {
    const matching = copies.filter((copy) => copy.bookId === bookId);
    const copy = matching[nth];
    if (!copy) throw new Error(`Seed bug: no copy ${nth} for book ${bookId}`);
    return copy;
  };

  console.log("Creating loans…");

  // 1. A healthy active loan, due next week.
  const activeCopy = copyFor(frankenstein.id, 0);
  await db.loan.create({
    data: {
      copyId: activeCopy.id,
      memberId: ada.id,
      issuedById: librarian.id,
      checkedOutAt: daysFromNow(-7),
      dueAt: daysFromNow(7),
    },
  });
  await db.bookCopy.update({
    where: { id: activeCopy.id },
    data: { status: "ON_LOAN" },
  });

  // 2. An overdue loan with the fine already assessed — gives the reporting
  //    dashboard and the overdue job something real to find.
  const overdueCopy = copyFor(persuasion.id, 0);
  const overdueLoan = await db.loan.create({
    data: {
      copyId: overdueCopy.id,
      memberId: brian.id,
      issuedById: librarian.id,
      checkedOutAt: daysFromNow(-30),
      dueAt: daysFromNow(-9),
    },
  });
  await db.bookCopy.update({
    where: { id: overdueCopy.id },
    data: { status: "ON_LOAN" },
  });
  await db.fine.create({
    data: {
      loanId: overdueLoan.id,
      // 9 days late at 25c/day.
      amountCents: 9 * 25,
      reason: "OVERDUE",
      assessedAt: daysFromNow(-1),
    },
  });

  // 3. A closed loan, returned on time. The partial unique index permits this
  //    copy to be lent again; the seeded state proves it.
  const returnedCopy = copyFor(narrative.id, 0);
  await db.loan.create({
    data: {
      copyId: returnedCopy.id,
      memberId: chidi.id,
      issuedById: librarian.id,
      checkedOutAt: daysFromNow(-45),
      dueAt: daysFromNow(-31),
      returnedAt: daysFromNow(-33),
    },
  });

  // 4. Every copy of one title out, so the hold queue below is meaningful.
  const notesCopies = copies.filter((c) => c.bookId === notesOnTheEngine.id);
  for (const [index, copy] of notesCopies.entries()) {
    await db.loan.create({
      data: {
        copyId: copy.id,
        memberId: index === 0 ? ada.id : chidi.id,
        issuedById: librarian.id,
        checkedOutAt: daysFromNow(-3),
        dueAt: daysFromNow(11),
      },
    });
    await db.bookCopy.update({
      where: { id: copy.id },
      data: { status: "ON_LOAN" },
    });
  }

  console.log("Creating holds…");
  // A queue two deep on the fully-loaned title. Position is derived from
  // placedAt, so the order here is the order they will be satisfied in.
  await db.hold.create({
    data: {
      bookId: notesOnTheEngine.id,
      memberId: brian.id,
      placedAt: daysFromNow(-2),
      status: "WAITING",
    },
  });
  await db.hold.create({
    data: {
      bookId: notesOnTheEngine.id,
      memberId: chidi.id,
      placedAt: daysFromNow(-1),
      status: "WAITING",
    },
  });

  const counts = {
    users: await db.user.count(),
    authors: await db.author.count(),
    books: await db.book.count(),
    copies: await db.bookCopy.count(),
    loans: await db.loan.count(),
    openLoans: await db.loan.count({ where: { returnedAt: null } }),
    overdue: await db.loan.count({
      where: { returnedAt: null, dueAt: { lt: new Date() } },
    }),
    holds: await db.hold.count(),
    fines: await db.fine.count(),
  };

  console.log("\nSeeded:");
  for (const [key, value] of Object.entries(counts)) {
    console.log(`  ${key.padEnd(12)} ${value}`);
  }
  console.log(`\nAll accounts use the password: ${DEMO_PASSWORD}`);
  console.log("  admin@myweblib.test      (ADMIN)");
  console.log("  librarian@myweblib.test  (LIBRARIAN)");
  console.log("  ada@myweblib.test        (MEMBER, 2 active loans)");
  console.log("  brian@myweblib.test      (MEMBER, 1 overdue + fine)");
  console.log("  chidi@myweblib.test      (MEMBER)");
  console.log("  dana@myweblib.test       (MEMBER, suspended)");
}

main()
  .then(() => db.$disconnect())
  .catch(async (error: unknown) => {
    console.error("\nSeed failed:", error);
    await db.$disconnect();
    process.exit(1);
  });
