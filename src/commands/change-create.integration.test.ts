import { execFile, spawnSync } from 'node:child_process'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'

import { expect, test } from 'vitest'

import { runChangeCreate } from './change-create'
import { runChangeStart } from './change-start'
import { defaultConfig } from '../config'
import { createFileStorage } from '../storages/implementations/file'
import { DEFAULT_GH_OPS } from '../test-utils/gh-ops-defaults'
import { createRepoGit } from '../utils/git-ops'

const exec = promisify(execFile)

async function fixture() {
	const root = await mkdtemp(path.join(tmpdir(), 'trowel-create-integration-'))
	const projectRoot = path.join(root, 'project')
	const remote = path.join(root, 'remote.git')
	await mkdir(projectRoot)
	const git = async (...args: string[]) => (await exec('git', ['-C', projectRoot, ...args])).stdout.trim()
	await exec('git', ['init', '--bare', remote])
	await git('init', '-b', 'develop')
	await git('config', 'user.email', 'test@example.com')
	await git('config', 'user.name', 'Test')
	await writeFile(path.join(projectRoot, 'tracked.txt'), 'original\n')
	await git('add', 'tracked.txt')
	await git('commit', '-m', 'fixture')
	await git('remote', 'add', 'origin', remote)
	await git('push', '-u', 'origin', 'develop')
	const ops = createRepoGit(projectRoot)
	const storage = createFileStorage({ git: ops, gh: DEFAULT_GH_OPS, labels: defaultConfig.labels, changesDir: path.join(projectRoot, 'changes') })
	return { root, projectRoot, git, rt: { projectRoot, git: ops, storage, stdout: () => {} } }
}

const raw = JSON.stringify({
	outcome: 'create-change', change: { title: 'Real Git', body: 'body' },
	slices: [
		{ title: 'First', body: 'one', blockedBy: [1], readyForAgent: true },
		{ title: 'Second', body: 'two', blockedBy: [], readyForAgent: false },
	],
})

test.each(['positional', 'stdin'])('real CLI creates file records via %s without launching configured harness', async (channel) => {
	const f = await fixture()
	try {
		const home = path.join(f.root, 'home')
		await mkdir(home)
		await mkdir(path.join(f.projectRoot, '.trowel'))
		await writeFile(path.join(f.projectRoot, '.trowel/config.json'), JSON.stringify({ storage: 'issue', docs: { changesDir: 'changes' }, agent: { harness: 'hermes' } }))
		const cli = path.resolve(import.meta.dirname, '../main.ts')
		const result = spawnSync(process.execPath, ['--import', import.meta.resolve('tsx'), cli, 'change', 'create', '--storage', 'file', ...(channel === 'positional' ? [raw] : [])], {
			cwd: f.projectRoot, env: { ...process.env, HOME: home }, input: channel === 'stdin' ? raw : '', encoding: 'utf8', timeout: 10_000,
		})
		expect(result.status, result.stderr).toBe(0)
		expect(result.stdout).toContain('Created Change 1')
		expect(await f.rt.storage.findChange('1')).toMatchObject({ title: 'Real Git', targetBranch: 'develop' })
		expect(await f.git('branch', '--show-current')).toBe('change-1-real-git')
	} finally {
		await rm(f.root, { recursive: true, force: true })
	}
})

test('real git and file storage preserve dirty work and Grill file, resolve forward blockers, and create no commits', async () => {
	const f = await fixture()
	try {
		const head = await f.git('rev-parse', 'HEAD')
		await mkdir(path.join(f.projectRoot, '.trowel'))
		const out = path.join(f.projectRoot, '.trowel/start-change-out.json')
		await writeFile(out, 'not JSON: unrelated Grill output\n')
		await writeFile(path.join(f.projectRoot, 'tracked.txt'), 'caller edits\n')
		await writeFile(path.join(f.projectRoot, 'untracked.txt'), 'untracked work\n')
		await runChangeCreate(f.rt, raw)
		expect(await f.git('branch', '--show-current')).toBe('change-1-real-git')
		expect(await f.git('rev-parse', 'HEAD')).toBe(head)
		expect(await f.git('ls-remote', 'origin', 'refs/heads/change-1-real-git')).toContain(head)
		expect(await f.git('stash', 'list')).toBe('')
		expect(await readFile(out, 'utf8')).toBe('not JSON: unrelated Grill output\n')
		expect(await readFile(path.join(f.projectRoot, 'tracked.txt'), 'utf8')).toBe('caller edits\n')
		expect(await readFile(path.join(f.projectRoot, 'untracked.txt'), 'utf8')).toBe('untracked work\n')
		expect(await f.rt.storage.findChange('1')).toMatchObject({ title: 'Real Git', targetBranch: 'develop', changeBranch: 'change-1-real-git' })
		const slices = await f.rt.storage.findSlices('1')
		expect(slices).toEqual([
			expect.objectContaining({ id: '2', title: 'First', blockedBy: ['3'], readyForAgent: true, sliceBranch: null }),
			expect.objectContaining({ id: '3', title: 'Second', blockedBy: [], readyForAgent: false, sliceBranch: null }),
		])
		// Persist prior file-storage ids before another stash-backed creation.
		await f.git('add', 'changes')
		await f.git('commit', '-m', 'persist fixture Change artifacts')
		await writeFile(path.join(f.projectRoot, '.git/info/exclude'), '.trowel/lock\n')
		await f.git('checkout', 'develop')
		await f.git('merge', '--ff-only', 'change-1-real-git')
		await f.git('push', 'origin', 'develop')
		await runChangeCreate(f.rt, raw)
		expect((await f.rt.storage.listChanges()).map((change) => change.id).sort()).toEqual(['1', '4'])
		expect(await f.git('branch', '--show-current')).toBe('change-4-real-git')
		expect(await readFile(out, 'utf8')).toBe('not JSON: unrelated Grill output\n')
	} finally {
		await rm(f.root, { recursive: true, force: true })
	}
})

test.each(['start', 'create'])('preserves existing %s conflict recovery when untracked records and lock collide', async (command) => {
	const f = await fixture()
	try {
		await runChangeCreate(f.rt, raw)
		const run = command === 'create'
			? () => runChangeCreate(f.rt, raw)
			: () => runChangeStart({
				...f.rt, changeStartPromptText: '', runInteractive: async () => {},
				readStartChangeOut: async () => raw, preflight: async () => {}, confirm: async () => true,
			})
		await expect(run()).rejects.toThrow(/could not restore untracked files from stash/)
		expect(await f.git('stash', 'list')).not.toBe('')
		expect(await f.git('branch', '--show-current')).toBe('change-1-real-git')
	} finally {
		await rm(f.root, { recursive: true, force: true })
	}
})

test('real git restores dirty files on remote failure while retaining partial file-storage record', async () => {
	const f = await fixture()
	try {
		await writeFile(path.join(f.projectRoot, 'tracked.txt'), 'keep me\n')
		await f.git('remote', 'remove', 'origin')
		await expect(runChangeCreate(f.rt, raw)).rejects.toThrow()
		expect(await f.git('branch', '--show-current')).toBe('develop')
		expect(await f.git('stash', 'list')).toBe('')
		expect(await readFile(path.join(f.projectRoot, 'tracked.txt'), 'utf8')).toBe('keep me\n')
		const store = JSON.parse(await readFile(path.join(f.projectRoot, 'changes/1/store.json'), 'utf8'))
		expect(store.title).toBe('Real Git')
	} finally {
		await rm(f.root, { recursive: true, force: true })
	}
})
