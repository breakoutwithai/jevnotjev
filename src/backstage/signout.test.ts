import { expect, test } from "bun:test";
import { SIGNED_OUT_URL, signOut, signOutRequest } from "./signout.ts";

test("[unit] A2 sign-out POST uses the session and no Authorization header", async () => {
  const calls: unknown[][] = [];
  const response = new Response(null, { status: 303 });
  const result = await signOutRequest((...args) => { calls.push(args); return Promise.resolve(response); });
  expect(result).toBe(response);
  expect(calls).toEqual([["/api/auth/sign-out", { method: "POST", credentials: "same-origin" }]]);
  const options = calls[0]?.[1];
  expect(options).not.toHaveProperty("headers");
});

test("[unit] A2 clear precedes POST and navigation follows POST", async () => {
  const calls: string[] = [];
  let complete: ((response: Response) => void) | undefined;
  const pending = signOut({
    clear: () => { calls.push("clear"); },
    request: () => { calls.push("POST"); return new Promise<Response>((resolve) => { complete = resolve; }); },
    navigate: (url) => { calls.push(`navigate:${url}`); },
    notice: (message) => { calls.push(`notice:${message}`); },
  });
  expect(calls).toEqual(["clear", "notice:Signing out. Keys and session cleared.", "POST"]);
  complete?.(new Response(null, { status: 303 }));
  await pending;
  expect(calls.at(-1)).toBe(`navigate:${SIGNED_OUT_URL}`);
});

for (const status of [200, 404, 502]) test(`[unit] A2 HTTP ${status} still navigates`, async () => {
  const calls: string[] = [];
  await signOut({
    clear: () => { calls.push("clear"); },
    request: () => { calls.push("POST"); return Promise.resolve(new Response(null, { status })); },
    navigate: (url) => { calls.push(`navigate:${url}`); },
    notice: () => {},
  });
  expect(calls).toEqual(["clear", "POST", `navigate:${SIGNED_OUT_URL}`]);
});

test("[unit] A2 rejected POST still navigates", async () => {
  const calls: string[] = [];
  await signOut({
    clear: () => { calls.push("clear"); },
    request: () => { calls.push("POST"); return Promise.reject(new Error("offline")); },
    navigate: (url) => { calls.push(`navigate:${url}`); },
    notice: () => {},
  });
  expect(calls).toEqual(["clear", "POST", `navigate:${SIGNED_OUT_URL}`]);
});
