import { test, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openTrial, type TrialConfig, type TrialLedger } from "./trial.ts";
const small = {
  question: "Refund?",
  choices: [
    { name: "yes", definition: "Refund requested" },
    { name: "no", definition: "No refund requested" },
  ],
  input: "Please refund this order",
};
function setup(overrides: Partial<TrialConfig> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "backstage-trial-"));
  const config: TrialConfig = {
    path: join(dir, "trial.sqlite"),
    fundedKey: "test-funded-key",
    signingSecret: "test-signing-secret-longer-than-thirty-two-characters",
    pricingVerified: true,
    worstCostMicroUsd: 10,
    dailyBudgetMicroUsd: 20,
    dailyMintLimit: 4,
    dailyNetworkMintLimit: 2,
    dailyNetworkAttemptLimit: 3,
    ...overrides,
  };
  const result = openTrial(config);
  if (!result.available) throw Error(result.reason);
  return {
    config,
    ledger: result.ledger,
    cleanup() {
      result.ledger.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
function mint(ledger: TrialLedger, ip = "127.0.0.1") {
  const result = ledger.mint(ip);
  if (result.kind !== "minted") throw Error(result.code);
  return result.token;
}
test("[integration] JF6 trial disabled without fully verified funding configuration", () => {
  expect(openTrial(undefined).available).toBe(false);
  const fixture = setup();
  try {
    expect(
      openTrial({ ...fixture.config, pricingVerified: false }).available,
    ).toBe(false);
    expect(
      openTrial({ ...fixture.config, worstCostMicroUsd: 0 }).available,
    ).toBe(false);
  } finally {
    fixture.cleanup();
  }
});
test("[integration] JF6 atomic allowance and budget reservations prevent duplicate or over-budget calls", async () => {
  const f = setup();
  try {
    const token = mint(f.ledger);
    const results = await Promise.all(
      [1, 2].map(async () => f.ledger.reserve(token, "same-request", small)),
    );
    expect(results.map((r) => r.kind).sort()).toEqual(["replay", "reserved"]);
    expect(f.ledger.reserve(token, "another-request", small).kind).toBe(
      "denied",
    );
    const second = mint(f.ledger, "127.0.0.2");
    expect(f.ledger.reserve(second, "next-request", small).kind).toBe(
      "reserved",
    );
    const third = mint(f.ledger, "127.0.0.3");
    expect(f.ledger.reserve(third, "over-budget", small)).toEqual({
      kind: "denied",
      code: "trial-exhausted",
    });
    expect(f.ledger.spentMicroUsd()).toBe(20);
  } finally {
    f.cleanup();
  }
});
test("[integration] JF6 restart holds uncertain reservations and never refills consumed browser allowance", () => {
  const f = setup();
  const token = mint(f.ledger);
  expect(f.ledger.reserve(token, "request-one", small).kind).toBe("reserved");
  f.ledger.close();
  const reopened = openTrial(f.config);
  if (!reopened.available) throw Error(reopened.reason);
  try {
    expect(reopened.ledger.reserve(token, "request-one", small)).toMatchObject({
      kind: "replay",
      state: "held-unknown",
    });
    expect(reopened.ledger.spentMicroUsd()).toBe(10);
    expect(reopened.ledger.reserve(token, "fresh-request", small).kind).toBe(
      "denied",
    );
  } finally {
    reopened.ledger.close();
    f.cleanup();
  }
});
test("[integration] JF6 known costs settle conservatively; only pre-dispatch rejection releases allowance", () => {
  const f = setup();
  try {
    const token = mint(f.ledger);
    const r = f.ledger.reserve(token, "request-one", small);
    if (r.kind !== "reserved") throw Error("reserve");
    f.ledger.settle(r.reservationId, { kind: "pre-dispatch-none" });
    expect(f.ledger.spentMicroUsd()).toBe(0);
    expect(f.ledger.reserve(token, "request-one", small).kind).toBe("replay");
    const retry = f.ledger.reserve(token, "request-two", small);
    if (retry.kind !== "reserved") throw Error("retry");
    f.ledger.settle(retry.reservationId, { kind: "known", costMicroUsd: 3 });
    expect(f.ledger.spentMicroUsd()).toBe(3);
    expect(f.ledger.reserve(token, "request-three", small).kind).toBe("denied");
  } finally {
    f.cleanup();
  }
});
test("[integration] JF6 provider denial trips durable funding hold without refund", () => {
  const f = setup();
  try {
    const r = f.ledger.reserve(mint(f.ledger), "request-one", small);
    if (r.kind !== "reserved") throw Error("reserve");
    f.ledger.settle(r.reservationId, { kind: "unknown", code: "http-401" });
    expect(f.ledger.spentMicroUsd()).toBe(10);
    expect(f.ledger.mint("127.0.0.2")).toEqual({
      kind: "denied",
      code: "trial-unavailable",
    });
  } finally {
    f.cleanup();
  }
});
test("[integration] JF6 bounded requests, signed tokens and durable network mint limits fail closed", () => {
  const f = setup();
  try {
    const token = mint(f.ledger);
    expect(f.ledger.reserve(token + "x", "request-one", small).kind).toBe(
      "denied",
    );
    expect(
      f.ledger.reserve(token, "request-one", {
        ...small,
        input: "x".repeat(1001),
      }),
    ).toEqual({ kind: "denied", code: "invalid-request" });
    mint(f.ledger);
    expect(f.ledger.mint("127.0.0.1")).toEqual({
      kind: "denied",
      code: "trial-exhausted",
    });
    expect(f.ledger.spentMicroUsd()).toBe(0);
  } finally {
    f.cleanup();
  }
});

test("[integration] JF6 UTC budget rollover preserves browser consumption and durable mint limits", () => {
  let now = Date.UTC(2026, 9, 4, 23, 59);
  const f = setup({ now: () => now });
  try {
    const token = mint(f.ledger);
    expect(f.ledger.reserve(token, "first", small).kind).toBe("reserved");
    mint(f.ledger);
    f.ledger.close();
    const reopened = openTrial(f.config);
    if (!reopened.available) throw Error(reopened.reason);
    try {
      expect(reopened.ledger.mint("127.0.0.1").kind).toBe("denied");
      now += 120000;
      expect(reopened.ledger.spentMicroUsd()).toBe(0);
      expect(reopened.ledger.reserve(token, "next-day", small).kind).toBe(
        "denied",
      );
      expect(reopened.ledger.mint("127.0.0.1").kind).toBe("minted");
    } finally {
      reopened.ledger.close();
    }
  } finally {
    f.cleanup();
  }
});
test("[integration] JF6 late settlement cannot release restart-held spend and provider hold survives restart", () => {
  const f = setup();
  const r = f.ledger.reserve(mint(f.ledger), "first", small);
  if (r.kind !== "reserved") throw Error("reserve");
  f.ledger.close();
  const reopened = openTrial(f.config);
  if (!reopened.available) throw Error(reopened.reason);
  try {
    reopened.ledger.settle(r.reservationId, { kind: "pre-dispatch-none" });
    expect(reopened.ledger.spentMicroUsd()).toBe(10);
    const next = reopened.ledger.reserve(
      mint(reopened.ledger, "127.0.0.2"),
      "next",
      small,
    );
    if (next.kind !== "reserved") throw Error("reserve");
    reopened.ledger.settle(next.reservationId, {
      kind: "unknown",
      code: "http-429",
    });
  } finally {
    reopened.ledger.close();
  }
  const held = openTrial(f.config);
  if (!held.available) throw Error(held.reason);
  try {
    expect(held.ledger.mint("127.0.0.3")).toEqual({
      kind: "denied",
      code: "trial-unavailable",
    });
  } finally {
    held.ledger.close();
    f.cleanup();
  }
});
test("[integration] JF6 independent concurrent SQLite writers cannot overspend the budget", async () => {
  const f = setup();
  try {
    const tokens = [1, 2, 3, 4].map((n) => mint(f.ledger, "127.0.0." + n));
    const script = `import {openTrial} from ${JSON.stringify(new URL("./trial.ts", import.meta.url).pathname)};const c=JSON.parse(process.argv[1]);const r=openTrial(c);if(!r.available)throw Error(r.reason);console.log(JSON.stringify(r.ledger.reserve(process.argv[2],'concurrent',JSON.parse(process.argv[3]))));r.ledger.close();`;
    const children = tokens.map((token) =>
      Bun.spawn(
        [
          "bun",
          "-e",
          script,
          JSON.stringify(f.config),
          token,
          JSON.stringify(small),
        ],
        { stdout: "pipe", stderr: "pipe" },
      ),
    );
    const output = await Promise.all(
      children.map(async (child) => {
        const text = await new Response(child.stdout).text();
        expect(await child.exited).toBe(0);
        return text;
      }),
    );
    expect(
      output.filter((text) => text.includes('"kind":"reserved"')),
    ).toHaveLength(2);
    expect(
      output.filter((text) => text.includes('"kind":"denied"')),
    ).toHaveLength(2);
    expect(f.ledger.spentMicroUsd()).toBe(20);
  } finally {
    f.cleanup();
  }
});

test("[integration] JF6 network attempt limits survive safe release and unknown costs remain reserved", () => {
  const f = setup({ dailyNetworkAttemptLimit: 1 });
  try {
    const token = mint(f.ledger);
    const r = f.ledger.reserve(token, "first", small);
    if (r.kind !== "reserved") throw Error("reserve");
    f.ledger.settle(r.reservationId, { kind: "pre-dispatch-none" });
    expect(f.ledger.reserve(token, "second", small)).toEqual({
      kind: "denied",
      code: "trial-exhausted",
    });
    const next = f.ledger.reserve(mint(f.ledger, "127.0.0.2"), "third", small);
    if (next.kind !== "reserved") throw Error("reserve");
    f.ledger.settle(next.reservationId, { kind: "unknown", code: "timeout" });
    expect(f.ledger.spentMicroUsd()).toBe(10);
    f.ledger.settle(next.reservationId, { kind: "known", costMicroUsd: 0 });
    expect(f.ledger.spentMicroUsd()).toBe(10);
  } finally {
    f.cleanup();
  }
});
test("[integration] JF6 invalid settlements fail and cost-bound breach trips funding hold", () => {
  const f = setup();
  try {
    const r = f.ledger.reserve(mint(f.ledger), "first", small);
    if (r.kind !== "reserved") throw Error("reserve");
    expect(() =>
      f.ledger.settle(r.reservationId, { kind: "known", costMicroUsd: 0.1 }),
    ).toThrow();
    expect(f.ledger.spentMicroUsd()).toBe(10);
    f.ledger.settle(r.reservationId, { kind: "known", costMicroUsd: 11 });
    expect(f.ledger.spentMicroUsd()).toBe(11);
    expect(f.ledger.mint("127.0.0.2").kind).toBe("denied");
  } finally {
    f.cleanup();
  }
});
test("[integration] JF6 unsupported schema fails closed and ledger never stores case text, keys or network address", async () => {
  const f = setup();
  try {
    const r = f.ledger.reserve(mint(f.ledger), "test-funded-key", small);
    if (r.kind !== "reserved") throw Error("reserve");
    f.ledger.settle(r.reservationId, {
      kind: "unknown",
      code: "test-funded-key",
    });
    f.ledger.close();
    const bytes = await Bun.file(f.config.path).text();
    for (const secret of [
      f.config.fundedKey,
      f.config.signingSecret,
      small.input,
      "127.0.0.1",
    ])
      expect(bytes).not.toContain(secret);
    const { Database } = await import("bun:sqlite");
    const db = new Database(f.config.path);
    db.exec("PRAGMA user_version=99");
    db.close();
    expect(openTrial(f.config).available).toBe(false);
  } finally {
    f.cleanup();
  }
});
