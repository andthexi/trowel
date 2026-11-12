import { changeCreationState, materialiseChange, stashIfDirty, type ChangeCreationRuntime, type CreatedChange } from './change-creation'
import { buildStorage, exitOnCommandError, loadCommandBase } from './runtime'
import { parseCreateChangeInput } from '../work/start-change-out'

export async function runChangeCreate(rt: ChangeCreationRuntime, raw: string): Promise<void> {
	const spec = parseCreateChangeInput(raw)
	const targetBranch = await rt.git.currentBranch()
	const result = changeCreationState(rt.git, targetBranch, await stashIfDirty(rt.git))
	try {
		printCreatedChange(rt, await materialiseChange(rt, result, spec))
	} catch (e) {
		await result.recover()
		throw e
	}
}

export async function changeCreate(raw: string, opts: { storage?: string }): Promise<void> {
	await exitOnCommandError('change create', async () => {
		const base = await loadCommandBase('change create')
		await runChangeCreate({
			projectRoot: base.projectRoot,
			git: base.git,
			storage: buildStorage(base, opts.storage ?? base.config.storage),
			stdout: (s) => process.stdout.write(s),
		}, raw)
	})
}

function printCreatedChange(rt: ChangeCreationRuntime, created: CreatedChange): void {
	rt.stdout(`\nCreated Change ${created.changeId}\n`)
	rt.stdout(`Change branch: ${created.changeBranch} (you are now on it)\n`)
	if (created.realIds.length > 0) rt.stdout('Slices:\n')
	for (const [i, slice] of created.spec.slices.entries()) rt.stdout(`  - ${created.realIds[i]} ${slice.title}\n`)
	rt.stdout('\nReview `git status` for uncommitted files, including file-storage artifacts. Commit at your discretion.\n')
	rt.stdout(`\nNext: trowel change work ${created.changeId}\n`)
}
