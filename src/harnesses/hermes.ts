import { detectCliVersion, spawnHarness, spawnPrintCommand, waitForChildExit } from './process.ts'
import type { HarnessAdapter, HarnessSpawnHandle, HarnessSpawnInteractiveArgs, HarnessSpawnPrintArgs, HarnessVersionInfo } from './types.ts'

function modelArgs(model: string | null): string[] {
	return model ? ['--model', model] : []
}

function hermesPrintArgs(args: HarnessSpawnPrintArgs): string[] {
	return [
		'chat',
		'--query-file',
		'-',
		'--oneshot',
		'--format',
		'stream-json',
		'--source',
		'tool',
		'--yolo',
		...modelArgs(args.model),
	]
}

function hermesInteractiveArgs(args: HarnessSpawnInteractiveArgs): string[] {
	const out = ['chat', '--cli', ...modelArgs(args.model)]
	if (args.initialPrompt) out.push('-q', args.initialPrompt)
	return out
}

function hermesInteractiveEnv(env: Record<string, string | undefined>, systemPrompt: string): Record<string, string | undefined> {
	return { ...env, HERMES_EPHEMERAL_SYSTEM_PROMPT: systemPrompt }
}

export const hermesHarness: HarnessAdapter = {
	name: 'hermes',
	// Hermes is provider-agnostic; null agent.model lets its active profile choose.
	defaultModel: '',

	async spawnPrint(args: HarnessSpawnPrintArgs): Promise<HarnessSpawnHandle> {
		return spawnPrintCommand('hermes', hermesPrintArgs(args), {
			cwd: args.cwd,
			prompt: args.prompt,
			logStream: args.logStream,
		})
	},

	async spawnInteractive(args: HarnessSpawnInteractiveArgs): Promise<HarnessSpawnHandle> {
		const child = spawnHarness('hermes', hermesInteractiveArgs(args), {
			cwd: args.cwd,
			stdio: 'inherit',
			env: hermesInteractiveEnv(process.env, args.systemPrompt),
		})
		return { child, waitForExit: waitForChildExit(child) }
	},

	async detectVersion(): Promise<HarnessVersionInfo> {
		return detectCliVersion('hermes', ['--version', '-V'])
	},
}

if (import.meta.vitest) {
	const { describe, test, expect } = import.meta.vitest

	describe('hermesHarness', () => {
		test('print args use one-shot stream-json mode and omit a null model', () => {
			const args = { model: null, prompt: 'do thing', cwd: '/tmp/x', logStream: process.stdout } satisfies HarnessSpawnPrintArgs
			expect(hermesPrintArgs(args)).toEqual([
				'chat',
				'--query-file',
				'-',
				'--oneshot',
				'--format',
				'stream-json',
				'--source',
				'tool',
				'--yolo',
			])
		})

		test('print args pass an explicit model override', () => {
			const args = { model: 'provider/model', prompt: 'do thing', cwd: '/tmp/x', logStream: process.stdout } satisfies HarnessSpawnPrintArgs
			expect(hermesPrintArgs(args)).toContainEqual('--model')
			expect(hermesPrintArgs(args)).toContainEqual('provider/model')
		})

		test('interactive args seed an initial prompt and omit a null model', () => {
			const args = { model: null, systemPrompt: 'system', cwd: '/tmp/x', initialPrompt: 'do thing' } satisfies HarnessSpawnInteractiveArgs
			expect(hermesInteractiveArgs(args)).toEqual(['chat', '--cli', '-q', 'do thing'])
		})

		test('interactive environment adds only the ephemeral system prompt', () => {
			const env = hermesInteractiveEnv({ BASE: 'kept' }, 'system')
			expect(env).toEqual({ BASE: 'kept', HERMES_EPHEMERAL_SYSTEM_PROMPT: 'system' })
		})
	})
}
