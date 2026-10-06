export const SIGN_OUT_PATH = "/api/auth/sign-out";
export const SIGNED_OUT_URL = "/backstage/sign-in?signed-out=1";

export function signOutRequest(send: (input: string, init: RequestInit) => Promise<Response>): Promise<Response> {
  return send(SIGN_OUT_PATH, { method: "POST", credentials: "same-origin", signal: AbortSignal.timeout(10000) });
}

export interface SignOutDeps {
  clear(): void;
  request(): Promise<Response>;
  navigate(url: string): void;
  notice(message: string): void;
}

export async function signOut(deps: SignOutDeps): Promise<boolean> {
  deps.clear();
  deps.notice("Signing out. Keys and session cleared.");
  try {
    const response = await deps.request();
    if (response.ok && response.redirected) {
      deps.navigate(SIGNED_OUT_URL);
      return true;
    }
  } catch {
    // A failed request leaves the server session valid.
  }
  deps.notice("Sign-out failed. Your keys are cleared, but you are still signed in. Try again, or close the browser.");
  return false;
}
