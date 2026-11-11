import { unlink, writeFile } from 'node:fs/promises'
import path from 'node:path'

import { detectCliVersion, spawnHarness, spawnPrintCommand } from './process.ts'
import type { HarnessAdapter, HarnessSpawnHandle, HarnessSpawnInteractiveArgs, HarnessSpawnPrintArgs, HarnessVersionInfo } from './types.ts'

function codexInteractiveArgs(args: HarnessSpawnInteractiveArgs): string[] {
	const out = [...modelArgs(args.model), '--cd', args.cwd]
	if (args.initialPrompt) out.push(args.initialPrompt)
	return out
}

function modelArgs(model: string | null): string[] {
	return model ? ['--model', model] : []
}

export const codexHarness: HarnessAdapter = {
	name: 'codex',
	// Placeholder — verify against `codex --list-models` at adapter-implementation time.
	defaultModel: 'gpt-5.1-codex',

	async spawnPrint(args: HarnessSpawnPrintArgs): Promise<HarnessSpawnHandle> {
		// `--json` streams NDJSON events per agent step (tool calls, results, deltas) rather than
		// only the final response. Flag name has shifted between codex CLI versions; verify
		// against `codex exec --help` if upgrading.
		return spawnPrintCommand(
			'codex',
			['exec', '--json', ...modelArgs(args.model), '--dangerously-bypass-approvals-and-sandbox', '--cd', args.cwd, '-'],
			{
				cwd: args.cwd,
				prompt: args.prompt,
				logStream: args.logStream,
			},
		)
	},

	// Codex has no --append-system-prompt; codex auto-discovers AGENTS.md in cwd.
	// Write the system prompt there before spawning, remove on exit.
	async spawnInteractive(args: HarnessSpawnInteractiveArgs): Promise<HarnessSpawnHandle> {
		const agentsPath = path.join(args.cwd, 'AGENTS.md')
		await writeFile(agentsPath, args.systemPrompt, 'utf8')

		const child = spawnHarness('codex', codexInteractiveArgs(args), { cwd: args.cwd, stdio: 'inherit' })
		const waitForExit = new Promise<number>((resolve, reject) => {
			child.on('error', reject)
			child.on('exit', async (code) => {
				try {
					await unlink(agentsPath)
				} catch (e) {
					if ((e as { code?: string }).code !== 'ENOENT') {
						// Best-effort cleanup; surface but don't fail the spawn promise.
					}
				}
				resolve(code ?? -1)
			})
		})
		return { child, waitForExit }
	},

	async detectVersion(): Promise<HarnessVersionInfo> {
		return detectCliVersion('codex', ['--version', '-V'])
	},
}

if (import.meta.vitest) {
	const { describe, test, expect } = import.meta.vitest

	describe('codexHarness', () => {
		test('kind is codex', () => {
			expect(codexHarness.name).toBe('codex')
		})
		test('interactive args include an initial prompt when present', () => {
			expect(codexInteractiveArgs({ model: 'm', systemPrompt: 's', cwd: '/tmp/x', initialPrompt: 'do thing' })).toEqual([
				'--model',
				'm',
				'--cd',
				'/tmp/x',
				'do thing',
			])
		})
		test('interactive args omit the model flag when model is null', () => {
			expect(codexInteractiveArgs({ model: null, systemPrompt: 's', cwd: '/tmp/x' })).toEqual([
				'--cd',
				'/tmp/x',
			])
		})
	})
}
