import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  apply,
  Config,
  describeCron,
  inject,
  loadState,
  name,
  nextFireTimes,
  parseCron,
  parseSchedule,
  planTasks,
  resolveStateDir,
  saveState,
  zoneOffsetMinutes,
} from '../src/index.ts'

interface RegisteredTool {
  name: string
  execute(args: never, exec: never): Promise<unknown>
  output: { render(args: never, value: never): Array<{ type: string; text?: string }> }
}

interface TestConfig {
  stateDir: string
  autoStart: boolean
  tickMs: number
  defaultZone: string
  historyLimit: number
  allowShell: boolean
  allowHttp: boolean
  maxLatenessMs: number
}

const BASE_CONFIG: TestConfig = {
  stateDir: '',
  autoStart: false,
  tickMs: 30_000,
  defaultZone: 'UTC',
  historyLimit: 200,
  allowShell: false,
  allowHttp: false,
  maxLatenessMs: 3_600_000,
}

let dir = ''

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'dsh-scheduler-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

/** Mount the plugin against a stub registry and hand back what it registered. */
function mountPlugin(
  overrides: Partial<TestConfig> = {},
  executors: Record<string, (input: never) => unknown> = {},
): Map<string, RegisteredTool> {
  const registered = new Map<string, RegisteredTool>()
  const ctx = { tools: { register: (def: RegisteredTool) => registered.set(def.name, def) } }
  apply(ctx as never, { ...BASE_CONFIG, stateDir: dir, ...overrides } as never, executors as never)
  return registered
}

/** Call a registered tool and return its raw result. */
async function call(tools: Map<string, RegisteredTool>, toolName: string, args: unknown): Promise<never> {
  const tool = tools.get(toolName)
  if (!tool) throw new Error(`tool ${toolName} not registered`)
  return (await tool.execute(args as never, {} as never)) as never
}

describe('plugin face', () => {
  it('exports the cordis function-plugin face', () => {
    expect(name).toBe('dsh-scheduler')
    expect(inject).toEqual(['tools'])
    expect(typeof apply).toBe('function')
    expect(Config).toBeTruthy()
  })

  it('registers exactly the eight scheduler tools', () => {
    const tools = mountPlugin()
    expect([...tools.keys()].sort()).toEqual([
      'sched_create',
      'sched_due',
      'sched_history',
      'sched_list',
      'sched_plan',
      'sched_remove',
      'sched_run_now',
      'sched_update',
    ])
  })
})

describe('zone parsing', () => {
  it('parses the accepted zone forms', () => {
    expect(zoneOffsetMinutes('UTC')).toBe(0)
    expect(zoneOffsetMinutes('GMT')).toBe(0)
    expect(zoneOffsetMinutes('Z')).toBe(0)
    expect(zoneOffsetMinutes('+08')).toBe(480)
    expect(zoneOffsetMinutes('+08:00')).toBe(480)
    expect(zoneOffsetMinutes('+0800')).toBe(480)
    expect(zoneOffsetMinutes('-05:30')).toBe(-330)
    expect(zoneOffsetMinutes('nonsense')).toBe(0)
  })
})

describe('cron parsing', () => {
  it('expands macros', () => {
    const spec = parseCron('0 0 * * *')
    expect(spec.valid).toBe(true)
    expect(spec.expression).toBe('0 0 * * *')
  })

  it('accepts wildcards, lists, ranges, steps and names', () => {
    for (const text of ['*/5 * * * *', '0 9-17 * * MON-FRI', '1,15 0 * * *', '0 0 1 JAN *', '5-10/2 * * * *']) {
      expect(parseCron(text).valid, text).toBe(true)
    }
  })

  it('folds day-of-week 7 onto Sunday', () => {
    const spec = parseCron('0 0 * * 7')
    expect(spec.valid).toBe(true)
    expect(spec.dayOfWeek.values).toEqual([0])
  })

  it('ignores a leading seconds field', () => {
    const spec = parseCron('30 0 12 * * *')
    expect(spec.valid).toBe(true)
    expect(spec.expression).toBe('0 12 * * *')
  })

  it('rejects malformed input instead of throwing', () => {
    for (const text of ['', 'not a cron', '0 0 * *', '99 0 * * *', '0 0 * * MONDAY', '5-1 * * * *']) {
      expect(parseCron(text).valid, text).toBe(false)
    }
  })

  it('describes a schedule in English', () => {
    expect(describeCron(parseCron('0 9 * * 1'))).toContain('at 09:00')
    expect(describeCron(parseCron('* * * * *'))).toContain('every minute')
  })
})

describe('next fire times', () => {
  it('finds the next midnight UTC', () => {
    const from = Date.UTC(2024, 0, 1, 12, 0, 0)
    const { times } = nextFireTimes(parseCron('0 0 * * *'), from, 0, 2)
    expect(times).toHaveLength(2)
    expect(new Date(times[0]).toISOString()).toBe('2024-01-02T00:00:00.000Z')
    expect(new Date(times[1]).toISOString()).toBe('2024-01-03T00:00:00.000Z')
  })

  it('respects a fixed zone offset', () => {
    const from = Date.UTC(2024, 0, 1, 0, 0, 0)
    const { times } = nextFireTimes(parseCron('0 9 * * *'), from, 480, 1)
    // 09:00 at +08:00 is 01:00 UTC the same day.
    expect(new Date(times[0]).toISOString()).toBe('2024-01-01T01:00:00.000Z')
  })

  it('matches weekday ranges', () => {
    const from = Date.UTC(2024, 0, 5, 0, 0, 0) // Friday
    const { times } = nextFireTimes(parseCron('0 0 * * MON-FRI'), from, 0, 1)
    // Saturday and Sunday are skipped.
    expect(new Date(times[0]).toISOString()).toBe('2024-01-08T00:00:00.000Z')
  })

  it('reports exhaustion for an impossible date', () => {
    const { times, exhausted } = nextFireTimes(parseCron('0 0 30 2 *'), Date.UTC(2024, 0, 1), 0, 1, 30)
    expect(times).toHaveLength(0)
    expect(exhausted).toBe(true)
  })
})

describe('schedule parsing', () => {
  it('parses intervals', () => {
    const parsed = parseSchedule('every 30m')
    expect(parsed.valid).toBe(true)
    expect(parsed.kind).toBe('interval')
    expect(parsed.interval?.ms).toBe(1_800_000)
  })

  it('parses cron and macros', () => {
    expect(parseSchedule('@daily').valid).toBe(true)
    expect(parseSchedule('0 */4 * * *').valid).toBe(true)
  })

  it('rejects unknown interval units and empty input', () => {
    expect(parseSchedule('every 5 fortnights').valid).toBe(false)
    expect(parseSchedule('').valid).toBe(false)
  })
})

describe('state store', () => {
  it('round-trips through the state file', () => {
    const file = join(dir, 'nested', 'state.json')
    const state = { version: 1, tasks: [], history: [] }
    saveState(file, state)
    expect(loadState(file).version).toBe(1)
  })

  it('recovers from a corrupt file', () => {
    const file = join(dir, 'state.json')
    saveState(file, { version: 1, tasks: [], history: [] })
    const { writeFileSync } = require('node:fs') as typeof import('node:fs')
    writeFileSync(file, '{ not json', 'utf8')
    expect(loadState(file).tasks).toEqual([])
  })

  it('resolves the default state directory under DSH_HOME', () => {
    const previous = process.env.DSH_HOME
    process.env.DSH_HOME = dir
    try {
      expect(resolveStateDir('')).toBe(join(dir, 'dsh-scheduler'))
    } finally {
      if (previous === undefined) delete process.env.DSH_HOME
      else process.env.DSH_HOME = previous
    }
  })
})

describe('plan heuristics', () => {
  it('proposes test and lint tasks for a testing objective', () => {
    const plan = planTasks('keep the test suite and lint green', '')
    const titles = plan.map(entry => entry.title)
    expect(titles).toContain('Run the test suite')
    expect(titles).toContain('Lint and format check')
  })

  it('is deterministic', () => {
    expect(planTasks('audit dependencies weekly', '')).toEqual(planTasks('audit dependencies weekly', ''))
  })

  it('honours a cadence override', () => {
    const plan = planTasks('run the build nightly', 'every 2h')
    expect(plan.every(entry => entry.schedule === 'every 2h')).toBe(true)
  })

  it('falls back to generic anchors when nothing matches', () => {
    const plan = planTasks('zzzz', '')
    expect(plan.length).toBeGreaterThan(0)
    expect(plan[0].schedule).toMatch(/\*/)
  })
})

describe('sched_create', () => {
  it('creates a task and persists it', async () => {
    const tools = mountPlugin()
    const result = (await call(tools, 'sched_create', {
      title: 'Nightly build',
      schedule: '0 3 * * *',
      kind: 'prompt',
      payload: 'run the build',
    })) as { valid: boolean; task: { id: string; nextRunMs: number } }
    expect(result.valid).toBe(true)
    expect(result.task.id).toBe('nightly-build')
    expect(result.task.nextRunMs).toBeGreaterThan(0)
    expect(loadState(join(dir, 'state.json')).tasks).toHaveLength(1)
  })

  it('rejects an invalid schedule', async () => {
    const tools = mountPlugin()
    const result = (await call(tools, 'sched_create', { title: 'Bad', schedule: 'nope', kind: 'prompt' })) as { valid: boolean; error: string }
    expect(result.valid).toBe(false)
    expect(result.error).toContain('schedule')
    expect(loadState(join(dir, 'state.json')).tasks).toHaveLength(0)
  })

  it('de-duplicates ids', async () => {
    const tools = mountPlugin()
    await call(tools, 'sched_create', { title: 'Same', schedule: 'every 1h', kind: 'prompt' })
    const second = (await call(tools, 'sched_create', { title: 'Same', schedule: 'every 1h', kind: 'prompt' })) as { task: { id: string } }
    expect(second.task.id).toBe('same-2')
  })
})

describe('sched_list / sched_update / sched_remove', () => {
  it('lists, updates and removes', async () => {
    const tools = mountPlugin()
    await call(tools, 'sched_create', { title: 'Alpha', schedule: 'every 1h', kind: 'prompt', tags: ['x'] })

    const listed = (await call(tools, 'sched_list', {})) as { count: number }
    expect(listed.count).toBe(1)

    const updated = (await call(tools, 'sched_update', { id: 'alpha', enabled: false, title: 'Alpha 2', schedule: 'every 2h' })) as { valid: boolean; task: { title: string; enabled: boolean; schedule: string } }
    expect(updated.valid).toBe(true)
    expect(updated.task.title).toBe('Alpha 2')
    expect(updated.task.enabled).toBe(false)
    expect(updated.task.schedule).toBe('every 2h')

    const removed = (await call(tools, 'sched_remove', { id: 'alpha' })) as { valid: boolean; remaining: number }
    expect(removed.valid).toBe(true)
    expect(removed.remaining).toBe(0)
  })

  it('filters by tag and enabled flag', async () => {
    const tools = mountPlugin()
    await call(tools, 'sched_create', { title: 'One', schedule: 'every 1h', kind: 'prompt', tags: ['keep'] })
    await call(tools, 'sched_create', { title: 'Two', schedule: 'every 1h', kind: 'prompt', enabled: false })
    expect(((await call(tools, 'sched_list', { tag: 'keep' })) as { count: number }).count).toBe(1)
    expect(((await call(tools, 'sched_list', { enabledOnly: true })) as { count: number }).count).toBe(1)
  })

  it('reports a missing id instead of throwing', async () => {
    const tools = mountPlugin()
    expect(((await call(tools, 'sched_update', { id: 'ghost', title: 'x' })) as { valid: boolean }).valid).toBe(false)
    expect(((await call(tools, 'sched_remove', { id: 'ghost' })) as { valid: boolean }).valid).toBe(false)
  })

  it('dry-run removal leaves the task in place', async () => {
    const tools = mountPlugin()
    await call(tools, 'sched_create', { title: 'Keep', schedule: 'every 1h', kind: 'prompt' })
    await call(tools, 'sched_remove', { id: 'keep', dryRun: true })
    expect(loadState(join(dir, 'state.json')).tasks).toHaveLength(1)
  })
})

describe('execution', () => {
  it('queues prompt tasks and drains them via sched_due', async () => {
    const tools = mountPlugin()
    await call(tools, 'sched_create', { title: 'Ping', schedule: 'every 1h', kind: 'prompt', payload: 'say hi' })

    const run = (await call(tools, 'sched_run_now', { id: 'ping' })) as { valid: boolean; run: { outcome: string } }
    expect(run.valid).toBe(true)
    expect(run.run.outcome).toBe('queued')

    const due = (await call(tools, 'sched_due', {})) as { count: number; items: Array<{ detail: string }> }
    expect(due.count).toBe(1)
    expect(due.items[0].detail).toBe('say hi')

    const drained = (await call(tools, 'sched_due', { clear: true })) as { count: number }
    expect(drained.count).toBe(1)
    expect(((await call(tools, 'sched_due', {})) as { count: number }).count).toBe(0)
  })

  it('refuses shell tasks unless enabled', async () => {
    const tools = mountPlugin()
    await call(tools, 'sched_create', { title: 'Shell', schedule: 'every 1h', kind: 'shell', payload: 'echo hi' })
    const run = (await call(tools, 'sched_run_now', { id: 'shell' })) as { run: { outcome: string; detail: string } }
    expect(run.run.outcome).toBe('skipped')
    expect(run.run.detail).toContain('allowShell')
  })

  it('runs shell tasks when enabled through the injected executor', async () => {
    const calls: string[] = []
    const tools = mountPlugin({ allowShell: true }, {
      shell: (input: { task: { payload: string } }) => {
        calls.push(input.task.payload)
        return { outcome: 'ok', detail: 'ran' }
      },
    })
    await call(tools, 'sched_create', { title: 'Shell', schedule: 'every 1h', kind: 'shell', payload: 'echo hi' })
    const run = (await call(tools, 'sched_run_now', { id: 'shell' })) as { run: { outcome: string } }
    expect(run.run.outcome).toBe('ok')
    expect(calls).toEqual(['echo hi'])
  })

  it('records failures from a throwing executor', async () => {
    const tools = mountPlugin({ allowShell: true }, {
      shell: () => { throw new Error('boom') },
    })
    await call(tools, 'sched_create', { title: 'Boom', schedule: 'every 1h', kind: 'shell', payload: 'x' })
    const run = (await call(tools, 'sched_run_now', { id: 'boom' })) as { run: { outcome: string; detail: string } }
    expect(run.run.outcome).toBe('error')
    expect(run.run.detail).toBe('boom')

    const listed = (await call(tools, 'sched_list', {})) as { tasks: Array<{ failCount: number; lastError: string }> }
    expect(listed.tasks[0].failCount).toBe(1)
    expect(listed.tasks[0].lastError).toBe('boom')
  })

  it('reschedules after a run', async () => {
    const tools = mountPlugin()
    await call(tools, 'sched_create', { title: 'Tick', schedule: 'every 1h', kind: 'prompt' })
    const before = (await call(tools, 'sched_list', {})) as { tasks: Array<{ nextRunMs: number }> }
    await call(tools, 'sched_run_now', { id: 'tick' })
    const after = (await call(tools, 'sched_list', {})) as { tasks: Array<{ nextRunMs: number }> }
    expect(after.tasks[0].nextRunMs).toBeGreaterThanOrEqual(before.tasks[0].nextRunMs)
  })

  it('records history newest last', async () => {
    const tools = mountPlugin()
    await call(tools, 'sched_create', { title: 'H', schedule: 'every 1h', kind: 'prompt' })
    await call(tools, 'sched_run_now', { id: 'h' })
    const history = (await call(tools, 'sched_history', {})) as { count: number; runs: Array<{ outcome: string }> }
    expect(history.count).toBe(1)
    expect(history.runs[0].outcome).toBe('queued')
  })
})

describe('sched_plan', () => {
  it('returns creatable entries with parsed schedules', async () => {
    const tools = mountPlugin()
    const plan = (await call(tools, 'sched_plan', { objective: 'keep tests and types green' })) as {
      count: number
      tasks: Array<{ title: string; scheduleValid: boolean; scheduleReading: string }>
    }
    expect(plan.count).toBeGreaterThan(0)
    expect(plan.tasks.every(entry => entry.scheduleValid)).toBe(true)
    expect(plan.tasks.every(entry => entry.scheduleReading.length > 0)).toBe(true)
  })

  it('feeds sched_create round-trip', async () => {
    const tools = mountPlugin()
    const plan = (await call(tools, 'sched_plan', { objective: 'audit dependencies' })) as {
      tasks: Array<{ title: string; schedule: string; kind: string; payload: string }>
    }
    for (const entry of plan.tasks) {
      await call(tools, 'sched_create', entry)
    }
    const listed = (await call(tools, 'sched_list', {})) as { count: number }
    expect(listed.count).toBe(plan.tasks.length)
  })
})

describe('persistence across mounts', () => {
  it('reloads tasks written by a previous mount', async () => {
    const first = mountPlugin()
    await call(first, 'sched_create', { title: 'Persisted', schedule: 'every 5m', kind: 'prompt' })

    const second = mountPlugin()
    const listed = (await call(second, 'sched_list', {})) as { count: number; tasks: Array<{ title: string }> }
    expect(listed.count).toBe(1)
    expect(listed.tasks[0].title).toBe('Persisted')
  })

  it('writes readable JSON to the state file', async () => {
    const tools = mountPlugin()
    await call(tools, 'sched_create', { title: 'Readable', schedule: 'every 5m', kind: 'prompt' })
    const raw = readFileSync(join(dir, 'state.json'), 'utf8')
    expect(() => JSON.parse(raw)).not.toThrow()
    expect(raw.endsWith('\n')).toBe(true)
  })
})
