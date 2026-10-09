// The Backstage promotion gate on HEAD's pull requests (#91): HEAD must come from a pull request
// merged into main. No issue number is required in its body.
//
//   gh api repos/<owner>/<repo>/commits/<sha>/pulls | bun .deploy/backstage-merged-pr.ts
//
// Exit 0 when the list holds a merged PR whose base is main, 1 otherwise (prints the reason).

function isRecord(value: unknown): value is { readonly [key: string]: unknown } {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** True when `pulls` (the GitHub commits/<sha>/pulls answer) holds a PR merged into main. */
export function hasMergedMainPr(pulls: unknown): boolean {
  if (!Array.isArray(pulls)) return false;
  return pulls.some((p: unknown) => {
    if (!isRecord(p)) return false;
    const merged = p.merged_at;
    const base = p.base;
    return typeof merged === "string" && merged !== "" && isRecord(base) && base.ref === "main";
  });
}

if (import.meta.main) {
  let pulls: unknown = null;
  try {
    pulls = JSON.parse(await Bun.stdin.text());
  } catch {
    pulls = null;
  }
  if (!hasMergedMainPr(pulls)) {
    console.error("No pull request merged into main contains HEAD");
    process.exit(1);
  }
}
