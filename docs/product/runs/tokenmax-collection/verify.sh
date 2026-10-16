#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../../../.."
report="$(mktemp)"
bundle="$(mktemp -d)"
trap 'rm -f "$report"; rm -rf "$bundle"' EXIT
bun test src/tokenmax-collection src/tokenmax-ingest src/backstage/tokenmax-preview.test.ts scripts/tokenmax-collection --reporter=junit --reporter-outfile="$report"
bun -e 'import {parseJunit} from "./scripts/gate.ts"; const results=parseJunit(await Bun.file(process.argv[1]).text()); if(results.size<1)throw Error("Zero selected test files");let total=0;for(const [file,n] of results){if(n.passed<1||n.failed>0)throw Error(`${file}: zero passes or failures`);total+=n.passed;console.log(`${file}: ${n.passed} passed`);} console.log(`Collection verification: ${results.size} files; ${total} tests passed`);' "$report"
bun build src/tokenmax-ingest/main.ts --target browser --outfile "$bundle/collect.js"
cmp "$bundle/collect.js" site/collect/collect.js
printf 'Browser bundle parity: PASS\n'

bun build scripts/tokenmax-collection/run.ts --target=node --format=esm --outfile "$bundle/collect.mjs"
cmp "$bundle/collect.mjs" scripts/tokenmax-collection/collect.mjs
printf 'Node bundle parity: PASS\n'
bun -e 'import {readdir} from "node:fs/promises";import {ingestDraft,promptFor} from "./src/tokenmax-ingest/ingest.ts";const root="docs/product/runs/tokenmax-collection";const files=await readdir(root+"/samples");if(files.length!==3)throw Error("Expected three sample payloads");for(const file of files){const result=ingestDraft(await Bun.file(root+"/samples/"+file).text());if(!result.ok||result.publication!=="synthetic-excluded")throw Error("Invalid or publishable sample");}let prompts=0;for(const provider of ["claude","codex"]){if(provider!=="claude"&&provider!=="codex")continue;for(const mode of ["host","jev"]){if(mode!=="host"&&mode!=="jev")continue;if((await Bun.file(`${root}/prompts/${provider}-${mode}.md`).text()).trim()!==promptFor(provider,mode).trim())throw Error("Prompt drift");prompts++;}}if(prompts!==4)throw Error("Missing prompt variants");console.log("Artifacts: 3 synthetic payloads valid; 4 participant prompts match visible UI");'
