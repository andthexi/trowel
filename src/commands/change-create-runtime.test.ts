import { afterEach, expect, test, vi } from 'vitest'

import { makeFakes } from './change-start.test-utils'

const mocks = vi.hoisted(() => ({ load: vi.fn(), storage: vi.fn() }))
vi.mock('./runtime', async (importOriginal) => ({
	...await importOriginal<typeof import('./runtime')>(),
	loadCommandBase: mocks.load,
	buildStorage: mocks.storage,
}))

afterEach(() => vi.restoreAllMocks())

test.each(['file', 'issue', undefined])('command builds selected storage %s without a harness runtime', async (storage) => {
	const { changeCreate } = await import('./change-create')
	const { rt, calls } = makeFakes({ startChangeOut: null })
	const base = { ...rt, config: { storage: 'issue' } }
	mocks.load.mockResolvedValue(base)
	mocks.storage.mockReturnValue(rt.storage)
	vi.spyOn(process.stdout, 'write').mockReturnValue(true)
	await changeCreate('{"outcome":"create-change","change":{"title":"entry","body":"body"},"slices":[]}', { storage })
	expect(mocks.load).toHaveBeenCalledWith('change create')
	expect(mocks.storage).toHaveBeenLastCalledWith(base, storage ?? 'issue')
	expect(calls.createChange).toEqual([{ title: 'entry', body: 'body' }])
})
