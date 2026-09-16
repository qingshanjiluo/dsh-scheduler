/**
 * End-to-end check of the built artifact: a real tick loop must fire a due
 * task, queue its prompt, reschedule it, and persist all of that to disk.
 * Run after `npm run build`.
 * @module
 */
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const mod = await import(new URL('../lib/index.js', import.meta.url).href)

const dir = mkdtempSync(join(tmpdir(), 'dsh-scheduler-e2e-'))
const registered = new Map()
mod.apply(
  { tools: { register: def => registered.set(def.name, def) } },
  {
    stateDir: dir,
    autoStart: true,
    tickMs: 1000,
    defaultZone: 'UTC',
    historyLimit: 50,
    allowShell: false,
    allowHttp: false,
    maxLatenessMs: 3600000,
  },
)

const call = async (name, args) => registered.get(name).execute(args, {})

// An interval task is due one second from now; the 1s ticker must catch it.
const created = await call('sched_create', {
  title: 'e2e ping',
  schedule: 'every 1s',
  kind: 'prompt',
  payload: 'tick',
})
assert.equal(created.valid, true, 'task created')

await new Promise(resolve => setTimeout(resolve, 2500))

const due = await call('sched_due', {})
assert.ok(due.count >= 1, `tick loop queued a prompt (got ${due.count})`)

const history = await call('sched_history', {})
assert.ok(history.count >= 1, `history recorded the run (got ${history.count})`)

const onDisk = JSON.parse(readFileSync(join(dir, 'state.json'), 'utf8'))
assert.equal(onDisk.tasks.length, 1, 'task persisted')
assert.ok(onDisk.tasks[0].runCount >= 1, 'run counter on disk')
assert.ok(onDisk.tasks[0].nextRunMs > 0, 'task rescheduled')

rmSync(dir, { recursive: true, force: true })
console.log('e2e-tick: ok — fired', due.count, 'due prompt(s), history', history.count, 'run(s)')
