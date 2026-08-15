import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { listCosmetics } from "../src/cosmetics.js";

const auditRoot = resolve("examples", "cosmetics");
const categoryRoot = resolve(auditRoot, "category-audit");
const knownSourceEmpty = new Map([
  [5856, "Official Lunar geometry contains no cubes (Sparkle Aura)."],
  [5857, "Official Lunar geometry contains no cubes (Heart Aura)."],
  [9282, "Official Lunar geometry contains no cubes (Crab Shoes)."],
]);

const catalog = await listCosmetics({ limit: 10_000 });
const expected = new Map();
for (const item of catalog.items) {
  expected.set(item.category, (expected.get(item.category) || 0) + 1);
}

const categories = [];
const unknownWarnings = [];
const sourceAssetGaps = [];
for (const [category, total] of [...expected].sort(([left], [right]) => left.localeCompare(right))) {
  const path = category === "dragon_wings"
    ? resolve(auditRoot, "dragon-wings-audit", "summary.json")
    : resolve(categoryRoot, category, "summary.json");
  const summary = JSON.parse(await readFile(path, "utf8"));
  const warnings = summary.warnings || [];
  for (const warning of warnings) {
    const reason = knownSourceEmpty.get(Number(warning.id));
    const entry = { category, ...warning, ...(reason ? { reason } : {}) };
    if (reason) sourceAssetGaps.push(entry);
    else unknownWarnings.push(entry);
  }
  categories.push({
    category,
    catalog: total,
    audited: summary.total,
    rendered: summary.rendered,
    failed: summary.failed,
    warnings: warnings.length,
    geometryFamilies: summary.familyCount ?? null,
  });
}

const sum = (key) => categories.reduce((total, row) => total + Number(row[key] || 0), 0);
const audit = {
  generatedAt: new Date().toISOString(),
  status: sum("audited") === catalog.total && sum("failed") === 0 && unknownWarnings.length === 0
    ? (sourceAssetGaps.length ? "passed_with_source_asset_gaps" : "passed")
    : "failed",
  catalogTotal: catalog.total,
  auditedTotal: sum("audited"),
  renderedTotal: sum("rendered"),
  renderFailures: sum("failed"),
  rendererWarnings: unknownWarnings,
  sourceAssetGaps,
  categories,
};

await mkdir(auditRoot, { recursive: true });
await writeFile(resolve(auditRoot, "audit-summary.json"), `${JSON.stringify(audit, null, 2)}\n`);

const table = [
  "| Category | Catalog | Audited | Failed | Warnings | Families |",
  "| --- | ---: | ---: | ---: | ---: | ---: |",
  ...categories.map((row) => (
    `| ${row.category} | ${row.catalog} | ${row.audited} | ${row.failed} | ${row.warnings} | ${row.geometryFamilies ?? "–"} |`
  )),
].join("\n");
const gaps = sourceAssetGaps.length
  ? sourceAssetGaps.map((gap) => `- ${gap.id} (${gap.category}): ${gap.reason}`).join("\n")
  : "- None";
const markdown = `# Lunar cosmetic render audit

Status: **${audit.status}**

- Catalog entries: ${audit.catalogTotal}
- Audited front/back: ${audit.auditedTotal}
- Render failures: ${audit.renderFailures}
- Renderer warnings: ${audit.rendererWarnings.length}
- Official source-asset gaps: ${audit.sourceAssetGaps.length}

${table}

## Official source-asset gaps

${gaps}
`;
await writeFile(resolve(auditRoot, "AUDIT.md"), markdown);
console.log(JSON.stringify(audit, null, 2));
