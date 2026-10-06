export const SIGN_OUT_PATH = "/api/auth/sign-out";
export const SIGNED_OUT_URL = "/backstage/sign-in?signed-out=1";

export function signOutRequest(send: (input: string, init: RequestInit) => Promise<Response>): Promise<Response> {
  return send(SIGN_OUT_PATH, { method: "POST", credentials: "same-origin" });
}

export interface SignOutDeps {
  clear(): void;
  request(): Promise<Response>;
  navigate(url: string): void;
  notice(message: string): void;
}

export async function signOut(deps: SignOutDeps): Promise<void> {
  deps.clear();
  deps.notice("Signing out. Keys and session cleared.");
  try {
    await deps.request();
  } catch {
    // Local keys and scene are cleared even if the request cannot complete.
  }
  deps.navigate(SIGNED_OUT_URL);
}
