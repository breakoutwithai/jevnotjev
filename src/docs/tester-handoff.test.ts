import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..", "..");
const path = join(root, "docs/uat/tester-handoff.md");
const doc = existsSync(path) ? readFileSync(path, "utf8") : "";

function section(heading: string): string {
  const start = doc.indexOf(`## ${heading}\n`);
  if (start < 0) return "";
  const rest = doc.slice(start + heading.length + 4);
  const end = rest.indexOf("\n## ");
  return end < 0 ? rest : rest.slice(0, end);
}

describe("outside tester handoff", () => {
  test("[integration] D21 task gives an observable complete run and honest time allowance", () => {
    for (const phrase of ["two possible answers", "first case", "run all cases", "judge", "verdict"])
      expect(section("Your task")).toContain(phrase);
    expect(section("Time and what to bring")).toContain("Expected time: 60 minutes.");
    expect(section("Time and what to bring")).toContain("not a measured completion time");
    expect(section("Time and what to bring")).toContain("optional");
    expect(doc.slice(0, doc.indexOf("\n## "))).toContain("Sharing results is optional");
  });
  test("[integration] D21 first-case completion is observable without exposing the blind answer", () => {
    const task = section("Your task");
    for (const phrase of ["Try first case", "failed or stopped calls", "cases not yet attempted", "Run remaining", "does not call it again", "have no answer", "No calls in progress.", "hidden until", "blind pick"])
      expect(task).toContain(phrase);
    expect(task).not.toContain("confirm that an answer or a visible error appears");
    const ui = readFileSync(join(root, "src/backstage/main.ts"), "utf8");
    for (const phrase of ["failed or stopped calls", "cases not yet attempted", "have no answer", "No calls in progress.", "Run remaining"])
      expect(ui).toContain(phrase);
    const page = readFileSync(join(root, "site/backstage/index.html"), "utf8");
    expect(page).toContain("Try first case");
  });
  test("[integration] D21 linked product documents and destination source files exist", () => {
    const links = [...doc.matchAll(/\]\(([^)]+)\)/g)].map(match => match[1] ?? "");
    const expected = new Map([
      ["https://jevnotjev.breakoutwithai.com/backstage/", "site/backstage/index.html"],
      ["https://jevnotjev.breakoutwithai.com/guide/", "site/guide/index.html"],
      ["https://jevnotjev.breakoutwithai.com/privacy/", "site/privacy/index.html"],
      ["https://github.com/breakoutwithai/jevnotjev/blob/main/docs/uat/tester-checklist.md", "docs/uat/tester-checklist.md"],
    ]);
    for (const [url, source] of expected) {
      expect(links).toContain(url);
      expect(existsSync(join(root, source))).toBe(true);
    }
    expect(links).toContain("https://github.com/breakoutwithai/jevnotjev/issues/new?template=tester-blocker.md");
    expect(existsSync(join(root, ".github/ISSUE_TEMPLATE/tester-blocker.md"))).toBe(true);
  });
  test("[integration] D21 access and billing match published guide without implying an invitation grants access", () => {
    const access = section("Get access before starting");
    for (const phrase of ["operator", "email and password", "Continue with Google", "does not grant access"])
      expect(access).toContain(phrase);
    const guide = readFileSync(join(root, "site/guide/index.html"), "utf8");
    for (const phrase of ["email and password", "Continue with Google", "request alone does not open"])
      expect(guide).toContain(phrase);
    const bring = section("Time and what to bring");
    for (const phrase of ["TypeSafe API key", "model provider key", "own accounts", "retries", "spending limit"])
      expect(bring).toContain(phrase);
  });
  test("[integration] D21 data boundary covers browser persistence and relay/provider limits", () => {
    const boundary = section("Keep your data private");
    for (const phrase of ["synthetic or redacted", "names", "emails", "account numbers", "browser tab", "provider", "through our server", "sign out or close", "does not save", "logs"])
      expect(boundary).toContain(phrase);
    expect(boundary).not.toMatch(/nothing (?:is stored|leaves)|never (?:stores|logs)|zero retention/i);
    const privacy = readFileSync(join(root, "site/privacy/index.html"), "utf8");
    expect(privacy).toContain("sign out or close the tab");
    expect(privacy).toContain("What leaves your browser");
    expect(boundary).toContain("provider key pass through our server");
    expect(boundary).toContain("does not save it");
    expect(privacy).toContain("your key through the Backstage server");
    expect(boundary).toContain("Backstage does not save cases, questions, answers, runs or provider keys");
    expect(boundary).not.toContain("The application does not save");
    const access = section("Get access before starting");
    for (const phrase of ["email", "optional website and idea", "database", "private case text", "provider keys"])
      expect(access).toContain(phrase);
    expect(privacy).toContain("email, optional website and idea");
    expect(privacy).toContain("database file on our server");
    for (const phrase of ["question coach", "starter cases", "Anthropic or OpenAI"])
      expect(boundary).toContain(phrase);
  });
  test("[integration] D21 feedback is optional and blocker evidence excludes secrets and raw inputs", () => {
    const feedback = section("If you get stuck or want to share feedback");
    expect(feedback).toContain("Sharing results is optional");
    expect(doc).not.toMatch(/(?:must|required to|have to) (?:share|send|report)/i);
    for (const phrase of ["optional", "jev@breakoutwithai.com", "step", "browser", "public", "keys", "passwords", "question", "case text", "answers", "raw exports", "Crop"])
      expect(feedback).toContain(phrase);
    expect(feedback.indexOf("jev@breakoutwithai.com")).toBeLessThan(feedback.indexOf("public"));
    expect(doc).not.toMatch(/tester (?:agreed|completed)|invitation (?:has been|was) sent/i);
  });
});
