// Backfill StackNode.phases for rows written before spec 17 step 2.
//
// Readers already fall back to deriving phases when the column is null, so this
// is an optimisation and a consistency pass, not a prerequisite. Run it to make
// the stored value explicit:
//
//   pnpm --filter @nexux/web stack:backfill-phases        # report only
//   pnpm --filter @nexux/web stack:backfill-phases --write
//
// Nodes that already hold phases are left untouched — they may have been edited
// by hand, and re-deriving would undo that.

import { prisma } from "@nexux/db";

import { columnsOf, phasesOf } from "../src/lib/stack/phases";

async function main() {
  const write = process.argv.includes("--write");
  const nodes = await prisma.stackNode.findMany({
    orderBy: { createdAt: "asc" },
  });
  const pending = nodes.filter((n) => n.phases === null);

  console.log(
    `${nodes.length} stack node(s); ${pending.length} without phases.`
  );
  if (!pending.length) return;

  let changed = 0;
  for (const node of pending) {
    const phases = phasesOf(node);
    const derived = columnsOf(phases);
    // A node with no commands at all derives to no phases. Persisting `[]`
    // would be indistinguishable from "not backfilled", so leave it null.
    if (!phases.length) {
      console.log(`  ${node.name}: no commands — skipped`);
      continue;
    }
    console.log(
      `  ${node.name}: ${phases.map((p) => `${p.role}(${p.exec})`).join(" -> ")}`
    );
    if (write) {
      await prisma.stackNode.update({
        where: { id: node.id },
        data: { phases, ...derived },
      });
    }
    changed++;
  }

  console.log(
    write
      ? `Wrote phases for ${changed} node(s).`
      : `Would write phases for ${changed} node(s). Re-run with --write.`
  );
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
