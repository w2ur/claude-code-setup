import { expect, test } from 'claude-code/testing'

test('/panel alternates open and closed', async ($, on) => {
  const kept = new Map<string, unknown>()
  on('store.get', (_, e) => ({ value: kept.get(e.key) }))
  on('store.set', (_, e) => {
    kept.set(e.key, e.value)
    return { value: undefined }
  })

  expect((await $.command.run({ command: 'panel', args: '' })).text).toBe('Panel opened.')
  expect((await $.command.run({ command: 'panel', args: '' })).text).toBe('Panel closed.')
  expect((await $.command.run({ command: 'panel', args: '' })).text).toBe('Panel opened.')
})
