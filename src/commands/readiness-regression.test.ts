import { expect, test } from 'vitest'

import { runChangeCreate } from './change-create'
import { runChangeStart } from './change-start'
import { makeFakes } from './change-start.test-utils'
import { defaultConfig } from '../config'
import { createIssueStorage } from '../storages/implementations/issue'
import { createGh } from '../utils/gh-ops'

test.each(['start', 'create'])('%s continues later blocker writes after already-absent readiness', async (command) => {
	const raw = JSON.stringify({
		outcome: 'create-change', change: { title: 'Unready', body: 'body' },
		slices: [
			{ title: 'First', body: 'one', blockedBy: [], readyForAgent: false },
			{ title: 'Second', body: 'two', blockedBy: [0], readyForAgent: false },
		],
	})
	const { rt, calls } = makeFakes({ startChangeOut: raw, createSliceIds: ['12', '13'] })
	const requests: string[][] = []
	const gh = createGh(async (args) => {
		requests.push(args)
		if (args.includes('DELETE')) return { ok: false, error: new Error('gh: Label does not exist (HTTP 404)') }
		if (args[0] === 'api' && args.includes('--paginate')) return { ok: true, stdout: '[[{"name":"unrelated"}]]', stderr: '' }
		throw new Error(`unexpected API mutation: ${args.join(' ')}`)
	})
	const storage = createIssueStorage({ gh, git: rt.git, changesDir: '', labels: defaultConfig.labels })
	rt.storage.setSliceReadyForAgent = storage.setSliceReadyForAgent
	if (command === 'start') await runChangeStart(rt)
	else await runChangeCreate(rt, raw)
	expect(calls.createSlice).toHaveLength(2)
	expect(calls.setSliceBlockers).toEqual([
		{ changeId: 'pid', sliceId: '12', blockedBy: [] },
		{ changeId: 'pid', sliceId: '13', blockedBy: ['12'] },
	])
	expect(requests.filter((args) => args.includes('DELETE')).map((args) => args[3])).toEqual([
		'repos/{owner}/{repo}/issues/12/labels/ready-for-agent',
		'repos/{owner}/{repo}/issues/13/labels/ready-for-agent',
	])
})
