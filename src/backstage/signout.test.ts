import { expect, test } from "bun:test";
import {
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

test("[unit] SO2 request sends one timed GET with XHR credentials", async () => {
  const request = new FakeRequest();
  const password = signOutPassword(new Uint8Array(16).fill(0xab));
  const result = replaceCachedLogin(request, password);
  expect(request.opened).toEqual(["GET", "/api/backstage/sign-out", true, "signed-out", password]);
  expect(request.timeout).toBe(10000);
  expect(request.sends).toEqual([[]]);
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
  await signOut({
    clear: () => { calls.push("clear"); cleared = true; },
    request: () => { expect(cleared).toBe(true); calls.push("request"); return Promise.resolve(401); },
    navigate: (url) => { calls.push(`navigate:${url}`); },
    notice: (message) => { calls.push(`notice:${message}`); },
  });
  expect(calls).toEqual([
    "clear",
    "notice:Signing out. Keys and session cleared.",
    "request",
    "navigate:/backstage/?signed-out=1",
  ]);
});

test("[unit] SO3 every response status navigates to the kept-login warning", async () => {
  for (const status of [0, 200, 404, 502]) {
    const calls: string[] = [];
    await signOut({
      clear: () => { calls.push("clear"); },
      request: () => { calls.push("request"); return Promise.resolve(status); },
      navigate: (url) => { calls.push(`navigate:${url}`); },
      notice: (message) => { calls.push(`notice:${message}`); },
    });
    expect(calls).toEqual([
      "clear",
      "notice:Signing out. Keys and session cleared.",
      "request",
      "navigate:/backstage/?signed-out=1",
    ]);
  }
});

test("[unit] SO3 rejected request still navigates to the kept-login warning", async () => {
  const calls: string[] = [];
  await signOut({
    clear: () => { calls.push("clear"); },
    request: () => { calls.push("request"); return Promise.reject(new Error("offline")); },
    navigate: (url) => { calls.push(`navigate:${url}`); },
    notice: (message) => { calls.push(`notice:${message}`); },
  });
  expect(calls).toEqual([
    "clear",
    "notice:Signing out. Keys and session cleared.",
    "request",
    "navigate:/backstage/?signed-out=1",
  ]);
});

test("[unit] SO4 only the signed-out query key identifies a kept login", () => {
  expect(keptLogin("?signed-out=1")).toBe(true);
  expect(keptLogin("?signed-out")).toBe(true);
  for (const search of ["", "?other=1", "?x=signed-out"])
    expect(keptLogin(search)).toBe(false);
});
