// The mod's own state, held by the engine for the session ($.state): the checkout it runs in, and whether a run is
// in flight. Declared here so atom() and read() type against it.
export type MathCheckRoot = string | null

declare module 'claude-code' {
  interface PluginState {
    'math-check': { root: MathCheckRoot; isBusy: boolean }
  }
}
