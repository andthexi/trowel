import type { ChangeMetadataPatch, Storage } from '../storages/types'
import type { GitOps } from '../utils/git-ops'
import { withMutationLock } from '../utils/mutation-lock'
import { slug as slugify } from '../utils/slug'
import type { CreateChangeStartOut } from '../work/start-change-out'

export type ChangeCreationRuntime = {
	projectRoot: string
	storage: Storage
	git: GitOps
	stdout: (s: string) => void
}

export type ChangeCreationState = {
	targetBranch: string
	stashed: boolean
	markMaterialised: () => void
	recover: () => Promise<void>
}

export type CreatedChange = { changeId: string; changeBranch: string; realIds: string[]; spec: CreateChangeStartOut }

export async function stashIfDirty(git: GitOps): Promise<boolean> {
	if (await git.isWorkingTreeClean()) return false
	await git.stashPush({ includeUntracked: true })
	return true
}

export async function recoverBeforeMaterialisation(git: GitOps, targetBranch: string, stashed: boolean): Promise<void> {
	if ((await git.currentBranch()) !== targetBranch) await git.checkout(targetBranch)
	if (stashed) await git.stashPop()
}

export function changeCreationState(git: GitOps, targetBranch: string, stashed: boolean): ChangeCreationState {
	let materialised = false
	return {
		targetBranch,
		stashed,
		markMaterialised: () => { materialised = true },
		recover: async () => {
			if (!materialised) await recoverBeforeMaterialisation(git, targetBranch, stashed)
		},
	}
}

export async function materialiseChange(rt: ChangeCreationRuntime, result: ChangeCreationState, spec: CreateChangeStartOut): Promise<CreatedChange> {
	return withMutationLock(rt.projectRoot, async () => {
		const created = await rt.storage.createChange(spec.change)
		const changeId = created.id
		const changeBranch = changeBranchName(changeId, created.title)
		const progress: CreatedChange = { changeId, changeBranch, realIds: [], spec }
		try {
			await rt.git.createRemoteBranch(changeBranch, result.targetBranch)
			await updateChangeMetadataOrThrow(rt, changeId, { targetBranch: result.targetBranch, changeBranch })
			result.markMaterialised()
			await rt.git.fetch(changeBranch)
			await rt.git.checkout(changeBranch)
			if (result.stashed) await rt.git.stashPop()
			await createChangeStartSlices(rt, changeId, spec, progress.realIds)
			await updateChangeStartSliceLinks(rt, changeId, spec, progress.realIds)
			return progress
		} catch (e) {
			printPartialCreation(rt, progress)
			throw e
		}
	})
}

function printPartialCreation(rt: ChangeCreationRuntime, created: CreatedChange): void {
	rt.stdout(`\nPartial creation: Change ${created.changeId}; intended Change branch: ${created.changeBranch} (may not exist yet).\n`)
	rt.stdout(`Created Slice ids: ${created.realIds.join(', ') || '(none confirmed)'}. Links/readiness may be incomplete.\n`)
	rt.stdout('Inspect storage, `git status`, and `git stash list` before further action. No automatic rollback or retry; another creation invocation creates a new Change.\n')
}

function changeBranchName(changeId: string, title: string): string {
	return `change-${changeId}-${slugify(title)}`
}

async function updateChangeMetadataOrThrow(rt: ChangeCreationRuntime, changeId: string, patch: ChangeMetadataPatch): Promise<void> {
	try {
		await rt.storage.updateChangeMetadata(changeId, patch)
	} catch (e) {
		throw new Error(`failed to update Change metadata for ${changeId}: ${(e as Error).message}`)
	}
}

async function createChangeStartSlices(rt: ChangeCreationRuntime, changeId: string, spec: CreateChangeStartOut, realIds: string[]): Promise<void> {
	for (const slice of spec.slices) {
		const created = await rt.storage.createSlice(changeId, { title: slice.title, body: slice.body })
		realIds.push(created.id)
	}
}

async function updateChangeStartSliceLinks(rt: ChangeCreationRuntime, changeId: string, spec: CreateChangeStartOut, realIds: string[]): Promise<void> {
	for (const [i, slice] of spec.slices.entries()) {
		const sliceId = realIds[i]!
		await rt.storage.setSliceBlockers(changeId, sliceId, slice.blockedBy.map((idx) => realIds[idx]!))
		await rt.storage.setSliceReadyForAgent(changeId, sliceId, slice.readyForAgent)
	}
}
