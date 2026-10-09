// D15 (PR B): the math-check mod. A "Check Jev!Jev math by hand" Button in the band above the prompt and
// /jnj-math-check [N] [records.csv], both only in a jevnotjev checkout (run.ts isRepo), both through run.ts check():
// one subprocess, `bun mods/math-check/export.ts <csv> --last N`, then a toast with the Summary sentence and the path.
import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import { BUTTON_LABEL, DEFAULT_N, fromButton, fromCommand, isRepo } from './run'
import type { Host, Outcome } from './run'

const rootRef: { readonly plugin: 'math-check'; readonly key: 'root' } = { plugin: 'math-check', key: 'root' }
const busyRef: { readonly plugin: 'math-check'; readonly key: 'isBusy' } = { plugin: 'math-check', key: 'isBusy' }
const root = atom(rootRef, null)
const isBusy = atom(busyRef, false)

function hostOf($: EngineInterface): Host {
  return {
    exists: path => $.fs.exists(path),
    list: async path => (await $.fs.list(path)).map(e => ({ name: e.name, kind: e.kind })),
    run: async (argv, cwd) => {
      const r = await $.process.run(argv, { cwd, timeoutMs: 300_000 })
      return { exitCode: r.exitCode, stdout: r.stdout, stderr: r.stderr }
    },
  }
}

// One run at a time: a second press while the first runs is told so and runs nothing.
async function guarded($: EngineInterface, go: (host: Host, cwd: string) => Promise<Outcome>): Promise<Outcome | null> {
  const cwd = await read($, root)
  if (cwd === null) return null
  if (await read($, isBusy)) {
    $.ui.toast('math-check: already running')
    return null
  }
  await update($, isBusy, () => true)
  try {
    const out = await go(hostOf($), cwd)
    $.ui.toast(out.text, { timeoutMs: 15_000 })
    return out
  } finally {
    await update($, isBusy, () => false)
  }
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    if (await isRepo(hostOf($), e.cwd)) {
      await update($, root, () => e.cwd)
      await $.command.register({
        name: 'jnj-math-check',
        description: `${BUTTON_LABEL}: export the last N cases (default ${DEFAULT_N}) to an xlsx with a formula hand check`,
        argumentHint: '[N] [records.csv]',
      })
    }
    return next(e)
  })

  on('command.run', { command: 'jnj-math-check' }, async ($, e) => {
    const out = await guarded($, (host, cwd) => fromCommand(host, cwd, e.args))
    return { text: out === null ? 'math-check: not run (already running, or not a jevnotjev checkout)' : out.text }
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const cwd = await read($, root)
    if (e.props.hasSurvey || cwd === null) return next(e)
    const busy = await read($, isBusy)
    const { Box, Button } = $.ui.resolve(e)
    return (
      <Box>
        <Button
          key="math-check"
          label={busy ? 'Checking Jev!Jev math...' : BUTTON_LABEL}
          onPress={() => void guarded($, (host, dir) => fromButton(host, dir))}
        />
      </Box>
    )
  })
}
