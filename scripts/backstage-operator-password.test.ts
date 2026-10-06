import { expect, test } from "bun:test";
import { verifyPasswordHash } from "../src/backstage/auth.ts";

test("[unit] OP1 generated row verifies and argv password is refused", async () => {
  const generated = Bun.spawnSync(["bun", "scripts/backstage-operator-password.ts", "User@Example.com"]);
  expect(generated.exitCode).toBe(0);
  const output = generated.stdout.toString();
  expect(output).toContain("user@example.com");
  const lines = output.trim().split("\n");
  const password = lines[0]?.slice("password: ".length) ?? "";
  const row: unknown = JSON.parse(lines[1] ?? "null");
  expect(typeof row === "object" && row !== null && "password_hash" in row && typeof row.password_hash === "string" && await verifyPasswordHash(password, row.password_hash)).toBe(true);
  expect(output.match(/"password_hash"/g)?.length).toBe(1);
  const refused = Bun.spawnSync(["bun", "scripts/backstage-operator-password.ts", "user@example.com", "password-in-argv"]);
  expect(refused.exitCode).toBe(2);
  const provided = Bun.spawnSync(["bun", "scripts/backstage-operator-password.ts", "user@example.com", "--stdin"], { stdin: Buffer.from("stdin-password\n") });
  expect(provided.exitCode).toBe(0);
  expect(provided.stdout.toString()).not.toContain("stdin-password");
  expect(provided.stdout.toString()).not.toContain("password:");
});
