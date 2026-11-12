import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, test } from 'vitest'

import { countCreatedCommits, countTurnCommits } from './_loop-wiring.ts'

const dirs: string[] = []

function git(cwd: string, ...args: string[]): string {
	return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()
}

function repo(): string {
	const dir = mkdtempSync(path.join(tmpdir(), 'trowel-count-created-'))
	dirs.push(dir)
	git(dir, 'init', '-q')
	git(dir, 'config', 'user.email', 'test@example.com')
	git(dir, 'config', 'user.name', 'Test')
	writeFileSync(path.join(dir, 'file.txt'), 'one\n')
	git(dir, 'add', 'file.txt')
	git(dir, 'commit', '-qm', 'base')
	return dir
}

afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('countCreatedCommits', () => {
	test('counts an ordinary descendant commit', async () => {
		const dir = repo()
		const before = git(dir, 'rev-parse', 'HEAD')
		git(dir, 'commit', '--allow-empty', '-qm', 'next')
		const after = git(dir, 'rev-parse', 'HEAD')
		expect(await countCreatedCommits(dir, before, after)).toBe(1)
	})

	test('counts an amended HEAD even though it is not a descendant', async () => {
		const dir = repo()
		const before = git(dir, 'rev-parse', 'HEAD')
		writeFileSync(path.join(dir, 'file.txt'), 'amended\n')
		git(dir, 'add', 'file.txt')
		git(dir, 'commit', '--amend', '--no-edit', '-q')
		const after = git(dir, 'rev-parse', 'HEAD')
		expect(await countCreatedCommits(dir, before, after)).toBe(1)
	})

	test('counts an amended branch ref even when the worktree HEAD stays stale', async () => {
		const dir = repo()
		const before = git(dir, 'rev-parse', 'HEAD')
		writeFileSync(path.join(dir, 'file.txt'), 'amended\n')
		git(dir, 'add', 'file.txt')
		git(dir, 'commit', '--amend', '--no-edit', '-q')
		const branchAfter = git(dir, 'rev-parse', 'HEAD')
		expect(await countCreatedCommits(dir, before, before, before, branchAfter)).toBe(1)
	})

	test('counts an already-present local commit not yet on origin', async () => {
		const dir = repo()
		git(dir, 'branch', '-M', 'slice')
		git(dir, 'remote', 'add', 'origin', dir)
		git(dir, 'update-ref', 'refs/remotes/origin/slice', 'HEAD')
		git(dir, 'commit', '--allow-empty', '-qm', 'local turn commit')
		const head = git(dir, 'rev-parse', 'HEAD')
		expect(await countTurnCommits(dir, 'slice', head, head, head, head)).toBe(1)
	})

	test('returns zero when HEAD is unchanged', async () => {
		const dir = repo()
		const head = git(dir, 'rev-parse', 'HEAD')
		expect(await countCreatedCommits(dir, head, head)).toBe(0)
	})
})
