#!/usr/bin/env node
// Fails (exit 1) when any tracked shell script contains CRLF.
//   npm run check:line-endings
import { checkShellLineEndings } from "./lib/line-endings.mjs";

const { checked, offenders } = checkShellLineEndings(process.cwd());

if (offenders.length > 0) {
  console.error("CRLF line endings found in tracked shell scripts:");
  for (const file of offenders) console.error(`  - ${file}`);
  console.error("\nFix: ensure .gitattributes is present, then run:\n  git add --renormalize .\n");
  process.exit(1);
}

console.log(`OK  ${checked.length} tracked shell script(s) use LF line endings.`);
