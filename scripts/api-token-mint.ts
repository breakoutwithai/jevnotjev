// Mint one /api/v1 bearer token (OD3: operator-minted, no self-serve). Prints the token once on stdout; the state file
// keeps only its sha256. Run on the host that serves the API, as the user the server runs as:
//
//   bun scripts/api-token-mint.ts --label <who>
//
// State file: JNJ_API_TOKENS_PATH, else $STATE_DIRECTORY/api-tokens.json, else $HOME/.jevnotjev/api-tokens.json (see
// src/backstage/api-tokens.ts). The server re-reads it when it changes; no restart. To revoke, delete the entry by id.
import { apiTokensPath, mintToken } from "../src/backstage/api-tokens.ts";

export const MINT_USAGE = "usage: bun scripts/api-token-mint.ts --label <who> (letters, digits, space, _ . @ -; up to 64)";

export interface MintIo {
  readonly out: (line: string) => void;
  readonly err: (line: string) => void;
}

export function mintMain(argv: readonly string[], env: Readonly<Record<string, string | undefined>>, io: MintIo): number {
  const at = argv.indexOf("--label");
  const label = at >= 0 ? argv[at + 1] : undefined;
  if (label === undefined || argv.length !== 2) {
    io.err(MINT_USAGE);
    return 2;
  }
  try {
    const minted = mintToken(apiTokensPath(env), label);
    io.err(`minted ${minted.id} for "${label}" into ${minted.path}; the token below is shown once and not stored`);
    io.out(minted.token);
    return 0;
  } catch (error) {
    io.err(`ERROR ${error instanceof Error ? error.message : "mint failed"}`);
    return 1;
  }
}

if (import.meta.main) {
  process.exit(mintMain(Bun.argv.slice(2), process.env, {
    out: (line) => process.stdout.write(line + "\n"),
    err: (line) => process.stderr.write(line + "\n"),
  }));
}
