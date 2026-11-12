import { expect, test, vi } from 'vitest'

import { runChangeCreate } from './change-create'
import { runChangeStart } from './change-start'
import { makeFakes } from './change-start.test-utils'

const spec = {
	outcome: 'create-change',
	change: { title: 'Caller Change', body: 'Caller body' },
	slices: [
		{ title: 'First', body: 'one', blockedBy: [], readyForAgent: true },
		{ title: 'Second', body: 'two', blockedBy: [0], readyForAgent: false },
	],
}

test.each([
	'not JSON', 'null', '{}', '',
	JSON.stringify({ outcome: 'no-change', reason: 'none' }),
	JSON.stringify({ outcome: 'existing-change', changeId: '1', reason: 'exists' }),
	JSON.stringify({ ...spec, change: { title: 3, body: 'body' } }),
	JSON.stringify({ ...spec, slices: [{ ...spec.slices[0], readyForAgent: 'true' }] }),
	...[-1, 0, 1, 0.5].map((ref) => JSON.stringify({ ...spec, slices: [{ ...spec.slices[0], blockedBy: [ref] }] })),
	JSON.stringify({ ...spec, slices: [{ ...spec.slices[0], blockedBy: [1] }, { ...spec.slices[1], blockedBy: [0] }] }),
])('rejects invalid input before any git or storage mutation %#', async (raw) => {
	const { rt, calls } = makeFakes({ startChangeOut: null, cleanTree: false })
	await expect(runChangeCreate(rt, raw)).rejects.toThrow()
	expect(calls.order).toEqual([])
})

test('validation errors name caller JSON, not the Grill output file', async () => {
	const { rt } = makeFakes({ startChangeOut: null })
	await expect(runChangeCreate(rt, '{}')).rejects.toThrow(/Invalid change create JSON/)
})

test('accepts empty slices and preserves string content without deduplication', async () => {
	const { rt, calls } = makeFakes({ startChangeOut: null })
	const raw = JSON.stringify({ ...spec, change: { title: '', body: '  body\n' }, slices: [] })
	await runChangeCreate(rt, raw)
	await runChangeCreate(rt, raw)
	expect(calls.createChange).toEqual([{ title: '', body: '  body\n' }, { title: '', body: '  body\n' }])
	expect(calls.createSlice).toEqual([])
})

test.each([true, false])('matches post-Grill materialisation with cleanTree=%s', async (cleanTree) => {
	const opts = { startChangeOut: JSON.stringify(spec), cleanTree, currentBranch: 'develop' }
	const start = makeFakes(opts)
	const create = makeFakes(opts)
	const stash = vi.spyOn(create.rt.git, 'stashPush')
	await runChangeStart(start.rt)
	await runChangeCreate(create.rt, JSON.stringify(spec))
	expect(create.calls.order).toEqual(start.calls.order)
	expect(create.gitState).toEqual(start.gitState)
	if (!cleanTree) expect(stash).toHaveBeenCalledWith({ includeUntracked: true })
})

test.each(['record', 'branch', 'metadata', 'fetch', 'checkout', 'stash', 'slice', 'blockers', 'readiness'] as const)(
	'preserves start recovery on %s failure', async (stage) => {
		const opts = { startChangeOut: JSON.stringify(spec), cleanTree: false, currentBranch: 'develop' }
		const start = makeFakes(opts)
		const create = makeFakes(opts)
		for (const { rt } of [start, create]) {
			const fail = async () => { throw new Error(`failed at ${stage}`) }
			if (stage === 'record') rt.storage.createChange = fail
			if (stage === 'branch') rt.git.createRemoteBranch = fail
			if (stage === 'metadata') rt.storage.updateChangeMetadata = fail
			if (stage === 'fetch') rt.git.fetch = fail
			if (stage === 'checkout') rt.git.checkout = fail
			if (stage === 'stash') rt.git.stashPop = fail
			if (stage === 'slice') rt.storage.createSlice = fail
			if (stage === 'blockers') rt.storage.setSliceBlockers = fail
			if (stage === 'readiness') rt.storage.setSliceReadyForAgent = fail
		}
		await expect(runChangeStart(start.rt)).rejects.toThrow(`failed at ${stage}`)
		await expect(runChangeCreate(create.rt, JSON.stringify(spec))).rejects.toThrow(`failed at ${stage}`)
		expect(create.calls.order).toEqual(start.calls.order)
		expect(create.gitState).toEqual(start.gitState)
		const restored = ['record', 'branch', 'metadata'].includes(stage)
		expect(create.gitState.stashStack).toBe(restored || ['slice', 'blockers', 'readiness'].includes(stage) ? 0 : 1)
	},
)

test('reports partial Change identity and completed Slice ids without retrying', async () => {
	const { rt, calls } = makeFakes({ startChangeOut: null, createSliceIds: ['12'] })
	const createSlice = rt.storage.createSlice
	rt.storage.createSlice = vi.fn(createSlice).mockImplementationOnce(createSlice).mockRejectedValueOnce(new Error('slice API down'))
	await expect(runChangeCreate(rt, JSON.stringify(spec))).rejects.toThrow(/slice API down/)
	const out = calls.stdout.join('')
	expect(out).toContain('Partial creation: Change pid')
	expect(out).toContain('change-pid-caller-change')
	expect(out).toContain('12')
	expect(out).toContain('git stash list')
	expect(out).toContain('new Change')
	expect(rt.storage.createSlice).toHaveBeenCalledTimes(2)
})

test('creates caller JSON on the invocation target without Grill or prompts', async () => {
	const { runChangeCreate } = await import('./change-create')
	const { rt, calls, gitState } = makeFakes({ startChangeOut: null, currentBranch: 'develop', createSliceIds: ['12', '13'] })
	rt.confirm = vi.fn(() => { throw new Error('must not prompt') })
	rt.runInteractive = vi.fn(() => { throw new Error('must not launch a harness') })
	rt.readStartChangeOut = vi.fn(() => { throw new Error('must not read Grill output') })
	rt.preflight = vi.fn(() => { throw new Error('must not run Grill preflight') })
	await runChangeCreate(rt, JSON.stringify(spec))
	expect(calls.createChange).toEqual([spec.change])
	expect(calls.createSlice.map((call) => call.spec)).toEqual(spec.slices.map(({ title, body }) => ({ title, body })))
	expect(calls.updateChangeMetadata).toEqual([{ changeId: 'pid', patch: { targetBranch: 'develop', changeBranch: 'change-pid-caller-change' } }])
	expect(calls.setSliceBlockers).toEqual([
		{ changeId: 'pid', sliceId: '12', blockedBy: [] },
		{ changeId: 'pid', sliceId: '13', blockedBy: ['12'] },
	])
	expect(calls.setSliceReadyForAgent.map((call) => call.ready)).toEqual([true, false])
	expect(gitState.current).toBe('change-pid-caller-change')
	expect(calls.stdout.join('')).toContain('Next: trowel change work pid')
	expect(rt.confirm).not.toHaveBeenCalled()
	expect(rt.runInteractive).not.toHaveBeenCalled()
	expect(rt.readStartChangeOut).not.toHaveBeenCalled()
	expect(rt.preflight).not.toHaveBeenCalled()
})
