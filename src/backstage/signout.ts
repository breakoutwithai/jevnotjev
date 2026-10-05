export const SIGN_OUT_PATH = "/api/backstage/sign-out";
export const SIGN_OUT_USER = "signed-out";
export const SIGNED_OUT_URL = "/backstage/?signed-out=1";
export const SIGN_OUT_TIMEOUT_MS = 10000;

export interface SignOutRequest {
  open(method: string, url: string, async: boolean, user: string, password: string): void;
  send(): void;
  timeout: number;
  status: number;
  onloadend: ((event: ProgressEvent<EventTarget>) => void) | null;
}

export function signOutPassword(random: Uint8Array): string {
  if (random.length !== 16) throw new Error("Sign-out password needs 16 random bytes");
  return Array.from(random, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function replaceCachedLogin(request: SignOutRequest, password: string): Promise<number> {
  return new Promise((resolve) => {
    request.onloadend = () => resolve(request.status);
    request.open("GET", SIGN_OUT_PATH, true, SIGN_OUT_USER, password);
    request.timeout = SIGN_OUT_TIMEOUT_MS;
    request.send();
  });
}

export interface SignOutDeps {
  clear(): void;
  request(): Promise<number>;
  navigate(url: string): void;
  notice(message: string): void;
}

export async function signOut(deps: SignOutDeps): Promise<void> {
  deps.clear();
  deps.notice("Signing out. Keys and session cleared.");
  try {
    await deps.request();
  } catch {
    // A failed request has status 0; still show the kept-login warning.
  }
  deps.navigate(SIGNED_OUT_URL);
}

export function keptLogin(search: string): boolean {
  return new URLSearchParams(search).has("signed-out");
}
