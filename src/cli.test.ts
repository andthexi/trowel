import { afterEach, expect, test, vi } from 'vitest'

import { run } from './cli'

const { create } = vi.hoisted(() => ({ create: vi.fn(async () => {}) }))
vi.mock('./commands/change-create', () => ({ changeCreate: create }))

const originalArgv = process.argv

function stdin(text: string): void {
	vi.spyOn(process.stdin, Symbol.asyncIterator).mockImplementation(async function* () { yield Buffer.from(text); return undefined })
}

async function expectRejected(args: string[], input: string, error: RegExp): Promise<void> {
	process.argv = ['node', 'trowel', 'change', 'create', ...args]
	stdin(input)
	const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true)
	const exit = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never)
	if (args.includes('--harness') || args.length > 1) exit.mockImplementationOnce(() => { throw new Error('commander exit') })
	run()
	await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(1))
	expect(stderr.mock.calls.map(([s]) => s).join('')).toMatch(error)
	expect(create).not.toHaveBeenCalled()
}

test('change create accepts piped JSON', async () => {
	process.argv = ['node', 'trowel', 'change', 'create']
	stdin(' {"outcome":"create-change"}\n')
	run()
	await vi.waitFor(() => expect(create).toHaveBeenCalledWith('{"outcome":"create-change"}', {}))
})

test.each([
	[[], ''],
	[[], '  \n'],
	[[''], ''],
	[['  '], ''],
])('rejects missing or empty input %#', async (args, input) => {
	await expectRejected(args, input, /non-empty JSON/)
})

test.each(['{}', '', ' '])('rejects both input channels even with positional %j', async (arg) => {
	await expectRejected([arg], '{}', /not both/)
})

test('rejects --harness', async () => {
	await expectRejected(['{}', '--harness', 'hermes'], '', /unknown option.*--harness/)
})

test('rejects more than one JSON argument', async () => {
	await expectRejected(['{}', '{}'], '', /too many arguments/)
})

afterEach(() => {
	process.argv = originalArgv
	vi.restoreAllMocks()
	create.mockClear()
})

test('change create accepts one raw JSON argument and forwards --storage', async () => {
	const raw = '{"outcome":"create-change","change":{"title":"x","body":"b"},"slices":[]}'
	process.argv = ['node', 'trowel', 'change', 'create', raw, '--storage', 'file']
	stdin('')
	vi.spyOn(process, 'exit').mockImplementation(() => undefined as never)
	run()
	await vi.waitFor(() => expect(create).toHaveBeenCalledWith(raw, { storage: 'file' }))
})
