import { expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

const run = (args = '') =>
  ({ command: 'panel', args, origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 120 } }) as Parameters<Engine['command']['run']>[0]

test('/panel alternates open and closed', async ($, on) => {
  const kept = new Map<string, unknown>()
  on('store.get', (_, e) => ({ value: kept.get(e.key) }))
  on('store.set', (_, e) => {
    kept.set(e.key, e.value)
    return { value: undefined }
  })

  expect((await $.command.run(run())).text).toBe('Panel opened.')
  expect((await $.command.run(run())).text).toBe('Panel closed.')
  expect((await $.command.run(run())).text).toBe('Panel opened.')
})
