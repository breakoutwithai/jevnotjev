import { randomBytes, scryptSync } from "node:crypto";
import { normalizeEmail } from "../src/backstage/auth.ts";

// Ported from groit apps/booth/scripts/make-operator-password.mjs:1-65 at ab3bd6d1.
export function generatePassword(): string {
  const alphabet = "abcdefghjkmnpqrstuvwxyz23456789";
  const pick = (): string => Array.from(randomBytes(4), (byte) => alphabet[byte % alphabet.length]).join("");
  return [pick(), pick(), pick()].join("-");
}

export async function main(args: readonly string[] = process.argv.slice(2)): Promise<number> {
  if (args.length < 1 || args.length > 2 || (args.length === 2 && args[1] !== "--stdin")) {
    console.error("usage: bun scripts/backstage-operator-password.ts <email> [--stdin]");
    return 2;
  }
  const email = normalizeEmail(args[0] ?? "");
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { console.error("Invalid email address."); return 2; }
  const password = args[1] === "--stdin" ? (await Bun.stdin.text()).replace(/[\r\n]+$/, "") : generatePassword();
  if (password.length < 8) { console.error("Password must be at least 8 characters."); return 2; }
  const salt = randomBytes(16).toString("hex");
  const hash = scryptSync(password, salt, 64).toString("hex");
  console.log(`password: ${password}`);
  console.log(JSON.stringify({ email, password_hash: `scrypt$${salt}$${hash}` }));
  return 0;
}

if (import.meta.main) process.exit(await main());
