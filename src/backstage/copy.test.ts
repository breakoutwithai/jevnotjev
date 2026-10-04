import { expect, test } from "bun:test";
import { copyDecision } from "./copy.ts";
import type { Scene } from "./contracts.ts";
const scene: Scene = {
  question: "Refund?",
  choices: [
    { name: "yes", definition: "Refund requested" },
    { name: "no", definition: "No refund" },
  ],
  acceptance: "Correct",
  exclusions: "",
  keywords: [],
  matchChoice: "yes",
  otherwiseChoice: "no",
  cases: [{ id: "x", input: "Please refund\nBACKSTAGE_CASE\n$(touch nope)" }],
};
test("[unit] JF5 copy preserves exact decision without interpolating case into shell", () => {
  const cli = copyDecision(scene, { jev: "private-key" }, "cli");
  expect(cli).toContain("$TYPESAFE_API_KEY");
  expect(cli).not.toContain("private-key");
  const payload = cli.split("\n").slice(1, -1).join("\n");
  expect(JSON.parse(payload).state).toBe(scene.cases[0]?.input);
  expect(
    cli.split("\n").filter((line) => line === "BACKSTAGE_CASE"),
  ).toHaveLength(1);
  expect(copyDecision(scene, {}, "playground")).toContain(
    JSON.stringify({ case: scene.cases[0]?.input }),
  );
});
test("[unit] JF5 copy rejects keys even when JSON escaping would hide their literal text", () => {
  const key = 'secret"with\\escape';
  expect(() =>
    copyDecision({ ...scene, acceptance: key }, { jev: key }, "cli"),
  ).toThrow("Remove provider keys");
});
