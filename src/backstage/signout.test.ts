import { expect, test } from "bun:test";
import {
  SIGN_OUT_PATH,
  SIGN_OUT_TIMEOUT_MS,
  SIGN_OUT_USER,
  SIGNED_OUT_URL,
  keptLogin,
  replaceCachedLogin,
  signOut,
  signOutPassword,
} from "./signout.ts";

class FakeRequest {
  opened: [string, string, boolean, string, string] | undefined;
  timeout = 0;
  status = 0;
  onloadend: ((event: ProgressEvent<EventTarget>) => void) | null = null;
  sends: unknown[][] = [];

  open(method: string, url: string, async: boolean, user: string, password: string) {
    this.opened = [method, url, async, user, password];
  }

  send(...args: unknown[]) {
    this.sends.push(args);
  }
}

test("[unit] SO2 wrong credentials use a random lowercase hex password", () => {
  const first = signOutPassword(new Uint8Array(16).fill(0xab));
  const second = signOutPassword(new Uint8Array(16).fill(0xcd));
  expect(first).toMatch(/^[0-9a-f]{32}$/);
  expect(second).toMatch(/^[0-9a-f]{32}$/);
  expect(first).not.toBe(second);
});

test("[unit] SO2 request sends one timed GET with XHR credentials and no header", async () => {
  const request = new FakeRequest();
  const password = signOutPassword(new Uint8Array(16).fill(0xab));
  const result = replaceCachedLogin(request, password);
  expect(request.opened).toEqual(["GET", SIGN_OUT_PATH, true, SIGN_OUT_USER, password]);
  expect(request.timeout).toBe(SIGN_OUT_TIMEOUT_MS);
  expect(request.sends).toEqual([[]]);
  expect("setRequestHeader" in request).toBe(false);
  request.status = 401;
  request.onloadend?.(Object.assign(new Event("loadend"), { lengthComputable: false, loaded: 0, total: 0 }));
  expect(await result).toBe(401);
});

test("[unit] SO2 request resolves status zero after network error or timeout", async () => {
  // XHR fires loadend with status 0 after an error, an abort or a timeout.
  const request = new FakeRequest();
  const result = replaceCachedLogin(request, "wrong-password");
  request.status = 0;
  request.onloadend?.(Object.assign(new Event("loadend"), { lengthComputable: false, loaded: 0, total: 0 }));
  expect(await result).toBe(0);
});

test("[unit] SO3 clear finishes synchronously before request and 401 navigates", async () => {
  const calls: string[] = [];
  let cleared = false;
  const result = await signOut({
    clear: () => { calls.push("clear"); cleared = true; },
    request: () => { expect(cleared).toBe(true); calls.push("request"); return Promise.resolve(401); },
    navigate: (url) => { calls.push(`navigate:${url}`); },
    notice: (message) => { calls.push(`notice:${message}`); },
  });
  expect(calls).toEqual(["clear", "request", `navigate:${SIGNED_OUT_URL}`]);
  expect(result).toEqual({ kind: "navigated", status: 401 });
});

test("[unit] SO3 zero status and rejected request still navigate after clearing", async () => {
  for (const request of [() => Promise.resolve(0), () => Promise.reject(new Error("offline"))]) {
    const calls: string[] = [];
    const result = await signOut({
      clear: () => { calls.push("clear"); },
      request,
      navigate: (url) => { calls.push(`navigate:${url}`); },
      notice: (message) => { calls.push(`notice:${message}`); },
    });
    expect(calls).toEqual(["clear", `navigate:${SIGNED_OUT_URL}`]);
    expect(result).toEqual({ kind: "navigated", status: 0 });
  }
});

test("[unit] SO3 ungated responses show the no-gate notice without navigation", async () => {
  for (const status of [200, 404]) {
    const calls: string[] = [];
    const result = await signOut({
      clear: () => { calls.push("clear"); },
      request: () => { calls.push("request"); return Promise.resolve(status); },
      navigate: (url) => { calls.push(`navigate:${url}`); },
      notice: (message) => { calls.push(`notice:${message}`); },
    });
    expect(calls).toEqual([
      "clear", "request",
      "notice:Keys and session cleared. No login gate answered, so there was no login to sign out of.",
    ]);
    expect(result).toEqual({ kind: "no-gate", status });
  }
});

test("[unit] SO4 only the signed-out query key identifies a kept login", () => {
  expect(keptLogin("?signed-out=1")).toBe(true);
  expect(keptLogin("?signed-out")).toBe(true);
  for (const search of ["", "?other=1", "?x=signed-out"])
    expect(keptLogin(search)).toBe(false);
});
