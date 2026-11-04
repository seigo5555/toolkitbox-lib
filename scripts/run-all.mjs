// scripts/check-*.ts を順に流し、1つでも失敗したら終了コード 1 で終わる。
import { readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";

const files = readdirSync(new URL(".", import.meta.url)).filter((f) => /^check-.*\.ts$/.test(f)).sort();
let failed = 0;
for (const f of files) {
  const r = spawnSync("npx", ["tsx", `scripts/${f}`], { stdio: "inherit" });
  if (r.status !== 0) {
    failed++;
    console.error(`FAILED: ${f}`);
  }
}
console.log(`\n${files.length - failed}/${files.length} check scripts passed`);
process.exit(failed ? 1 : 0);
