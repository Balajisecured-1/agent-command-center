import { expect, test } from 'claude-code/testing'
import { newModel, reduce } from '../lib/model'
test('entropy catch-all', () => {
  const m = reduce(newModel('s', 1), { k: 'request.start', t: 2, text: 'use Zk9x2Qm7Lp4Rt8Vn3Wb6Yc1Hd5 now, see src/lib/model.ts and components/agent-command-center/hooks' } as any)
  const j = JSON.stringify(m)
  expect(j.includes('Zk9x2Qm7Lp4Rt8Vn3Wb6Yc1Hd5')).toBe(false)
  expect(j.includes('src/lib/model.ts')).toBe(true)
})
