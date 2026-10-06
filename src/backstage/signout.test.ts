import { expect, spyOn, test } from "bun:test";
import { SIGNED_OUT_URL, signOut, signOutRequest } from "./signout.ts";

const failureNotice = "Sign-out failed. Your keys are cleared, but you are still signed in. Try again, or close the browser.";

function redirectedResponse(): Response {
  const response = new Response(null, { status: 200 });
  Object.defineProperty(response, "redirected", { value: true });
  return response;
}

test("[unit] A2 sign-out POST uses the session and no Authorization header", async () => {
  const calls: unknown[][] = [];
  const response = new Response(null, { status: 303 });
  const durations: number[] = [];
  const signal = new AbortController().signal;
  const spy = spyOn(AbortSignal, "timeout").mockImplementation((milliseconds) => {
    durations.push(milliseconds);
    return signal;
  });
  try {
    const result = await signOutRequest((...args) => { calls.push(args); return Promise.resolve(response); });
    expect(result).toBe(response);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.[0]).toBe("/api/auth/sign-out");
    const options = calls[0]?.[1];
    expect(options).not.toHaveProperty("headers");
    expect(options).toMatchObject({ method: "POST", credentials: "same-origin", signal });
    expect(durations).toEqual([10000]);
  } finally {
    spy.mockRestore();
  }
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
  complete?.(redirectedResponse());
  expect(await pending).toBe(true);
  expect(calls.at(-1)).toBe(`navigate:${SIGNED_OUT_URL}`);
});

for (const status of [200, 404, 502]) test(`[unit] A2 HTTP ${status} without a successful redirect fails`, async () => {
  const calls: string[] = [];
  const success = await signOut({
    clear: () => { calls.push("clear"); },
    request: () => {
      calls.push("POST");
      const response = new Response(null, { status });
      if (status === 502) Object.defineProperty(response, "redirected", { value: true });
      return Promise.resolve(response);
    },
    navigate: (url) => { calls.push(`navigate:${url}`); },
    notice: (message) => { calls.push(`notice:${message}`); },
  });
  expect(success).toBe(false);
  expect(calls).toEqual(["clear", "notice:Signing out. Keys and session cleared.", "POST", `notice:${failureNotice}`]);
});

test("[unit] A2 rejected POST fails without navigation", async () => {
  const calls: string[] = [];
  const success = await signOut({
    clear: () => { calls.push("clear"); },
    request: () => { calls.push("POST"); return Promise.reject(new Error("offline")); },
    navigate: (url) => { calls.push(`navigate:${url}`); },
    notice: (message) => { calls.push(`notice:${message}`); },
  });
  expect(success).toBe(false);
  expect(calls).toEqual(["clear", "notice:Signing out. Keys and session cleared.", "POST", `notice:${failureNotice}`]);
});

test("[unit] A2 timed-out POST fails without navigation", async () => {
  const calls: string[] = [];
  const controller = new AbortController();
  const spy = spyOn(AbortSignal, "timeout").mockImplementation(() => controller.signal);
  try {
    const pending = signOut({
      clear: () => { calls.push("clear"); },
      request: () => signOutRequest((_input, init) => {
        expect(init.signal).toBe(controller.signal);
        return new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener("abort", () => reject(new DOMException("Timed out", "TimeoutError")));
        });
      }),
      navigate: (url) => { calls.push(`navigate:${url}`); },
      notice: (message) => { calls.push(`notice:${message}`); },
    });
    controller.abort(new DOMException("Timed out", "TimeoutError"));
    expect(await pending).toBe(false);
    expect(calls).toEqual(["clear", "notice:Signing out. Keys and session cleared.", `notice:${failureNotice}`]);
  } finally {
    spy.mockRestore();
  }
});
