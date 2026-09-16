/**
 * Autonomous scheduled-task planner and runner for DeepSeek runtime.
 *
 * This plugin turns scheduling into something the model can drive end to end:
 * `sched_plan` decomposes a stated objective into a concrete multi-task
 * schedule, `sched_create` materialises those tasks, a background tick loop
 * fires them when they come due, and `sched_due` / `sched_history` report what
 * happened. Task state lives in a JSON file under the runtime home so it
 * survives restarts.
 *
 * Everything is deterministic and self-contained: the clock, the timer, the
 * store, and the task executors are all injectable seams. By default a `prompt`
 * task is only *queued* (the agent picks it up via `sched_due`), while `shell`
 * and `http` tasks are refused unless the deployment explicitly opts in through
 * config — so merely installing the plugin cannot run anything on its own.
 *
 * @module @qingshanjiluo/dsh-scheduler
 */

import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import z from '@deepseek-ai/schemastery'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

export const name = 'dsh-scheduler'
export const inject = ['tools']

/** One task the scheduler owns. */
type TaskKind = 'prompt' | 'shell' | 'http'

/** Task record persisted to the state file. */
type Task = {
  id: string
  title: string
  /** Cron expression or `every <n><unit>` interval text. */
  schedule: string
  kind: TaskKind
  /** Free text for `prompt`, a command line for `shell`, a URL for `http`. */
  payload: string
  enabled: boolean
  createdAtMs: number
  updatedAtMs: number
  lastRunMs: number
  nextRunMs: number
  runCount: number
  failCount: number
  lastError: string
  tags: string[]
}

/** One execution attempt, kept in a bounded ring. */
type RunRecord = {
  atMs: number
  taskId: string
  title: string
  kind: TaskKind
  outcome: 'ok' | 'error' | 'skipped' | 'queued'
  detail: string
  durationMs: number
}

/** Persisted scheduler state. */
type State = {
  version: number
  tasks: Task[]
  history: RunRecord[]
}

/** Deployment configuration for the scheduler. */
export interface Config {
  /** Directory holding `state.json`. Empty means `<DSH_HOME|~/.dsh>/dsh-scheduler`. */
  stateDir: string
  /** Run the background tick loop. Turn off to drive the scheduler by hand. */
  autoStart: boolean
  /** How often the tick loop looks for due tasks, in milliseconds. */
  tickMs: number
  /** Wall-clock zone used to read cron fields. Fixed offsets only. */
  defaultZone: string
  /** Keep at most this many run records. */
  historyLimit: number
  /** Permit `shell` tasks to execute. Off by default. */
  allowShell: boolean
  /** Permit `http` tasks to execute. Off by default. */
  allowHttp: boolean
  /** A due task whose lateness exceeds this is recorded as skipped. */
  maxLatenessMs: number
}

/** Schemastery configuration for the scheduler. */
export const Config: z<Config> = z.object({
  stateDir: z.string().default(''),
  autoStart: z.boolean().default(true),
  tickMs: z.number().default(30_000),
  defaultZone: z.string().default('UTC'),
  historyLimit: z.number().default(200),
  allowShell: z.boolean().default(false),
  allowHttp: z.boolean().default(false),
  maxLatenessMs: z.number().default(3_600_000),
})

/* ---------------------------------------------------------------------------------- */
/* Zone handling                                                                        */
/* ---------------------------------------------------------------------------------- */

/** Parse `UTC`, `Z`, `GMT`, `[+-]HH`, `[+-]HH:MM`, or `[+-]HHMM` into minutes. */
export function zoneOffsetMinutes(zone: string): number {
  const text = (zone || '').trim().toUpperCase()
  if (text === '' || text === 'UTC' || text === 'Z' || text === 'GMT') return 0
  const match = /^([+-])(\d{1,2})(?::?(\d{2}))?$/.exec(text)
  if (!match) return 0
  const sign = match[1] === '-' ? -1 : 1
  const hours = Number(match[2])
  const minutes = match[3] === undefined ? 0 : Number(match[3])
  if (!Number.isFinite(hours) || !Number.isFinite(minutes)) return 0
  if (hours > 23 || minutes > 59) return 0
  return sign * (hours * 60 + minutes)
}

/** Format an offset as `+HH:MM`. */
function offsetLabel(minutes: number): string {
  const sign = minutes < 0 ? '-' : '+'
  const absolute = Math.abs(minutes)
  const hh = String(Math.floor(absolute / 60)).padStart(2, '0')
  const mm = String(absolute % 60).padStart(2, '0')
  return `${sign}${hh}:${mm}`
}

/* ---------------------------------------------------------------------------------- */
/* Cron parsing                                                                         */
/* ---------------------------------------------------------------------------------- */

const MONTH_ALIASES: Record<string, number> = {
  JAN: 1, FEB: 2, MAR: 3, APR: 4, MAY: 5, JUN: 6,
  JUL: 7, AUG: 8, SEP: 9, OCT: 10, NOV: 11, DEC: 12,
}
const DOW_ALIASES: Record<string, number> = { SUN: 0, MON: 1, TUE: 2, WED: 3, THU: 4, FRI: 5, SAT: 6 }
const MACROS: Record<string, string> = {
  '@yearly': '0 0 1 1 *',
  '@annually': '0 0 1 1 *',
  '@monthly': '0 0 1 * *',
  '@weekly': '0 0 * * 0',
  '@daily': '0 0 * * *',
  '@midnight': '0 0 * * *',
  '@hourly': '0 * * * *',
}

/** A cron field expanded to the set of matching values. */
type CronField = { all: boolean; values: number[] }

/** A parsed cron expression. */
type CronSpec = {
  valid: boolean
  error: string
  source: string
  expression: string
  minute: CronField
  hour: CronField
  dayOfMonth: CronField
  month: CronField
  dayOfWeek: CronField
}

type FieldBounds = { min: number; max: number; starMax: number; aliases?: Record<string, number> }

const FIELD_BOUNDS: Record<'minute' | 'hour' | 'dayOfMonth' | 'month' | 'dayOfWeek', FieldBounds> = {
  minute: { min: 0, max: 59, starMax: 59 },
  hour: { min: 0, max: 23, starMax: 23 },
  dayOfMonth: { min: 1, max: 31, starMax: 31 },
  month: { min: 1, max: 12, starMax: 12, aliases: MONTH_ALIASES },
  dayOfWeek: { min: 0, max: 7, starMax: 6, aliases: DOW_ALIASES },
}

/** Expand one comma-separated cron field. */
function expandField(raw: string, bounds: FieldBounds): CronField | string {
  const text = raw.trim()
  if (text === '' || text === '*' || text === '?') {
    return { all: true, values: [] }
  }
  const collected = new Set<number>()
  for (const part of text.split(',')) {
    const chunk = part.trim()
    if (chunk === '') return `empty term in field "${raw}"`
    const stepSplit = chunk.split('/')
    if (stepSplit.length > 2) return `too many "/" in "${chunk}"`
    let step = 1
    if (stepSplit.length === 2) {
      const parsedStep = Number(stepSplit[1])
      if (!Number.isInteger(parsedStep) || parsedStep < 1) return `bad step in "${chunk}"`
      step = parsedStep
    }
    const base = stepSplit[0].trim()
    let from: number
    let to: number
    if (base === '*' || base === '?') {
      from = bounds.min
      to = bounds.starMax
    } else if (base.includes('-')) {
      const range = base.split('-')
      if (range.length !== 2) return `bad range in "${chunk}"`
      const low = resolveValue(range[0], bounds)
      const high = resolveValue(range[1], bounds)
      if (low === null || high === null) return `bad range bound in "${chunk}"`
      if (low > high) return `range start after end in "${chunk}"`
      from = low
      to = high
    } else {
      const single = resolveValue(base, bounds)
      if (single === null) return `bad value "${base}"`
      from = single
      to = stepSplit.length === 2 ? bounds.starMax : single
    }
    for (let value = from; value <= to; value += step) collected.add(value)
  }
  if (collected.size === 0) return `field "${raw}" matched nothing`
  const values = [...collected].sort((a, b) => a - b)
  return { all: false, values }
}

/** Resolve one value or alias inside the field bounds. */
function resolveValue(token: string, bounds: FieldBounds): number | null {
  const text = token.trim().toUpperCase()
  if (text === '') return null
  if (bounds.aliases && text in bounds.aliases) return bounds.aliases[text]
  const parsed = Number(text)
  if (!Number.isInteger(parsed)) return null
  // Day of week accepts 7 as Sunday; fold it back onto 0.
  if (bounds.min === 0 && bounds.max === 7 && parsed === 7) return 0
  if (parsed < bounds.min || parsed > bounds.max) return null
  return parsed
}

/** Parse a cron expression or macro into field tables. */
export function parseCron(source: string): CronSpec {
  const empty: CronField = { all: true, values: [] }
  const blank: CronSpec = {
    valid: false,
    error: '',
    source: source.trim(),
    expression: '',
    minute: empty,
    hour: empty,
    dayOfMonth: empty,
    month: empty,
    dayOfWeek: empty,
  }
  const text = source.trim()
  if (text === '') return { ...blank, error: 'expression is empty' }
  // Five fields, or six with a leading seconds field that this plugin ignores.
  let fields = text.split(/\s+/)
  if (fields.length > 5) {
    if (fields.length !== 6) return { ...blank, error: 'expected 5 cron fields (or 6 with leading seconds)' }
    fields = fields.slice(1)
  }
  if (fields.length !== 5) return { ...blank, error: 'expected 5 cron fields' }
  const keys = ['minute', 'hour', 'dayOfMonth', 'month', 'dayOfWeek'] as const
  const parsed: Partial<Record<(typeof keys)[number], CronField>> = {}
  for (let index = 0; index < keys.length; index += 1) {
    const key = keys[index]
    const outcome = expandField(fields[index], FIELD_BOUNDS[key])
    if (typeof outcome === 'string') return { ...blank, error: `${key}: ${outcome}` }
    parsed[key] = outcome
  }
  return {
    valid: true,
    error: '',
    source: text,
    expression: fields.join(' '),
    minute: parsed.minute as CronField,
    hour: parsed.hour as CronField,
    dayOfMonth: parsed.dayOfMonth as CronField,
    month: parsed.month as CronField,
    dayOfWeek: parsed.dayOfWeek as CronField,
  }
}

/** Normalize a macro to its five-field form. */
function normalizeSchedule(raw: string): string {
  const text = raw.trim()
  const lower = text.toLowerCase()
  if (lower in MACROS) return MACROS[lower]
  return text
}

/** English reading of a parsed spec. */
export function describeCron(spec: CronSpec): string {
  if (!spec.valid) return `invalid: ${spec.error}`
  const parts: string[] = []
  if (spec.minute.all && spec.hour.all) parts.push('every minute')
  else if (spec.hour.all) parts.push(`at minute ${clockText(spec.minute, 2)}`)
  else parts.push(`at ${clockText(spec.hour, 2)}:${spec.minute.all ? '00' : clockText(spec.minute, 2)}`)
  if (!spec.dayOfMonth.all) parts.push(`on day-of-month ${fieldText(spec.dayOfMonth)}`)
  if (!spec.month.all) parts.push(`in month ${fieldText(spec.month)}`)
  if (!spec.dayOfWeek.all) parts.push(`on weekday ${fieldText(spec.dayOfWeek)}`)
  return parts.join(', ')
}

/** Render a field's values as a compact list. */
function fieldText(field: CronField): string {
  if (field.all) return '*'
  return field.values.join(',')
}

/** Render a clock field with each value zero-padded, as clock parts are read. */
function clockText(field: CronField, width: number): string {
  if (field.all) return '*'
  return field.values.map(value => String(value).padStart(width, '0')).join(',')
}

/** True when the calendar day matches the day-of-month/day-of-week pair. */
function dayMatches(spec: CronSpec, year: number, month: number, day: number, weekday: number): boolean {
  const domAll = spec.dayOfMonth.all
  const dowAll = spec.dayOfWeek.all
  const domHit = domAll || spec.dayOfMonth.values.includes(day)
  const dowHit = dowAll || spec.dayOfWeek.values.includes(weekday)
  // Standard cron: when both are restricted, either match fires.
  if (!domAll && !dowAll) return domHit || dowHit
  if (!domAll) return domHit
  if (!dowAll) return dowHit
  return true
}

/** Minutes since the epoch in the configured fixed-offset zone. */
function localMs(epochMs: number, offsetMinutes: number): number {
  return epochMs + offsetMinutes * 60_000
}

/**
 * Compute the next fire times after `fromMs`.
 * Walks forward minute by minute, bounded by `maxDays`.
 */
export function nextFireTimes(
  spec: CronSpec,
  fromMs: number,
  offsetMinutes: number,
  count: number,
  maxDays = 366,
): { times: number[]; exhausted: boolean } {
  const times: number[] = []
  if (!spec.valid || count <= 0) return { times, exhausted: false }
  const minutes = spec.minute.all ? null : new Set(spec.minute.values)
  const hours = spec.hour.all ? null : new Set(spec.hour.values)
  const months = spec.month.all ? null : new Set(spec.month.values)
  // Start at the next whole minute strictly after `fromMs`.
  let cursor = Math.floor(fromMs / 60_000) * 60_000 + 60_000
  const limit = cursor + maxDays * 24 * 60 * 60_000
  while (cursor <= limit && times.length < count) {
    const shifted = localMs(cursor, offsetMinutes)
    const date = new Date(shifted)
    const month = date.getUTCMonth() + 1
    const day = date.getUTCDate()
    const weekday = date.getUTCDay()
    const hour = date.getUTCHours()
    const minute = date.getUTCMinutes()
    const fits =
      (months === null || months.has(month)) &&
      (hours === null || hours.has(hour)) &&
      (minutes === null || minutes.has(minute)) &&
      dayMatches(spec, date.getUTCFullYear(), month, day, weekday)
    if (fits) times.push(cursor)
    cursor += 60_000
  }
  return { times, exhausted: times.length < count }
}

/* ---------------------------------------------------------------------------------- */
/* Interval schedules                                                                   */
/* ---------------------------------------------------------------------------------- */

/** A parsed `every <n><unit>` interval. */
type Interval = { valid: boolean; error: string; ms: number; text: string }

const UNIT_MS: Record<string, number> = {
  s: 1_000,
  sec: 1_000,
  second: 1_000,
  seconds: 1_000,
  m: 60_000,
  min: 60_000,
  minute: 60_000,
  minutes: 60_000,
  h: 3_600_000,
  hour: 3_600_000,
  hours: 3_600_000,
  d: 86_400_000,
  day: 86_400_000,
  days: 86_400_000,
}

/**
 * Parse a schedule string.
 * Accepts cron (with macros) or an interval such as `every 30m`.
 */
export function parseSchedule(raw: string): { kind: 'cron' | 'interval'; cron: CronSpec | null; interval: Interval | null; valid: boolean; error: string; text: string } {
  const text = raw.trim()
  const empty: Interval = { valid: false, error: '', ms: 0, text: '' }
  if (text === '') {
    return { kind: 'cron', cron: null, interval: null, valid: false, error: 'schedule is empty', text: '' }
  }
  const intervalMatch = /^every\s+(\d+)\s*([a-z]+)$/i.exec(text)
  if (intervalMatch) {
    const amount = Number(intervalMatch[1])
    const unit = intervalMatch[2].toLowerCase()
    const unitMs = UNIT_MS[unit]
    if (!Number.isInteger(amount) || amount < 1) {
      return { kind: 'interval', cron: null, interval: empty, valid: false, error: 'interval amount must be a positive integer', text }
    }
    if (unitMs === undefined) {
      return { kind: 'interval', cron: null, interval: empty, valid: false, error: `unknown interval unit "${unit}"`, text }
    }
    const ms = amount * unitMs
    return { kind: 'interval', cron: null, interval: { valid: true, error: '', ms, text }, valid: true, error: '', text }
  }
  const spec = parseCron(normalizeSchedule(text))
  return { kind: 'cron', cron: spec, interval: null, valid: spec.valid, error: spec.error, text }
}

/** Next fire time for a parsed schedule, or -1 when none can be found. */
function nextForSchedule(schedule: string, fromMs: number, offsetMinutes: number): { nextRunMs: number; detail: string } {
  const parsed = parseSchedule(schedule)
  if (!parsed.valid) return { nextRunMs: -1, detail: parsed.error }
  if (parsed.kind === 'interval' && parsed.interval) {
    return { nextRunMs: fromMs + parsed.interval.ms, detail: `every ${Math.round(parsed.interval.ms / 1000)}s` }
  }
  if (parsed.cron) {
    const { times } = nextFireTimes(parsed.cron, fromMs, offsetMinutes, 1)
    return { nextRunMs: times[0] ?? -1, detail: describeCron(parsed.cron) }
  }
  return { nextRunMs: -1, detail: 'unparsed schedule' }
}

/* ---------------------------------------------------------------------------------- */
/* Store                                                                                */
/* ---------------------------------------------------------------------------------- */

const STATE_VERSION = 1

/** Resolve the directory holding the state file. */
export function resolveStateDir(configured: string): string {
  if (configured.trim() !== '') return configured.trim()
  const home = process.env.DSH_HOME && process.env.DSH_HOME.trim() !== ''
    ? process.env.DSH_HOME.trim()
    : join(homedir(), '.dsh')
  return join(home, 'dsh-scheduler')
}

/** An empty state document. */
function emptyState(): State {
  return { version: STATE_VERSION, tasks: [], history: [] }
}

/** Read state, tolerating a missing or corrupt file. */
export function loadState(file: string): State {
  if (!existsSync(file)) return emptyState()
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as Partial<State>
    const tasks = Array.isArray(parsed.tasks) ? parsed.tasks : []
    const history = Array.isArray(parsed.history) ? parsed.history : []
    return { version: STATE_VERSION, tasks: tasks as Task[], history: history as RunRecord[] }
  } catch {
    return emptyState()
  }
}

/** Write state atomically, creating the directory when needed. */
export function saveState(file: string, state: State): void {
  mkdirSync(dirname(file), { recursive: true })
  const temporary = `${file}.tmp`
  writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, 'utf8')
  renameSync(temporary, file)
}

/* ---------------------------------------------------------------------------------- */
/* Executors                                                                            */
/* ---------------------------------------------------------------------------------- */

/** What an executor is handed for one run. */
export type ExecInput = { task: Task; nowMs: number }

/** What an executor reports back. */
export type ExecResult = { outcome: RunRecord['outcome']; detail: string }

/** Executors keyed by task kind; overridable for tests or host integration. */
export type Executors = Partial<Record<TaskKind, (input: ExecInput) => Promise<ExecResult> | ExecResult>>

/* ---------------------------------------------------------------------------------- */
/* Time formatting helpers                                                              */
/* ---------------------------------------------------------------------------------- */

/** ISO text for an epoch value, or an empty string for the sentinel -1. */
function iso(ms: number): string {
  return ms > 0 ? new Date(ms).toISOString() : ''
}

/* ---------------------------------------------------------------------------------- */
/* Shared schema fragments                                                              */
/* ---------------------------------------------------------------------------------- */

const TASK_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    id: { type: 'string', required: true, description: 'Stable identifier used by update/remove/run.' },
    title: { type: 'string', required: true, description: 'Human label for the task.' },
    schedule: { type: 'string', required: true, description: 'Cron expression, macro, or `every <n><unit>` interval.' },
    kind: { type: 'string', required: true, enum: ['prompt', 'shell', 'http'], description: 'What the task does when it fires.' },
    payload: { type: 'string', required: true, description: 'Prompt text, shell command line, or URL.' },
    enabled: { type: 'boolean', required: true, description: 'Whether the tick loop will fire it.' },
    nextRunMs: { type: 'integer', required: true, description: 'Next fire time in epoch ms; -1 when unschedulable.' },
    nextRunIso: { type: 'string', required: true, description: 'Next fire time as ISO text; empty when unschedulable.' },
    lastRunMs: { type: 'integer', required: true, description: 'Last fire time in epoch ms; 0 when never run.' },
    lastRunIso: { type: 'string', required: true, description: 'Last fire time as ISO text; empty when never run.' },
    runCount: { type: 'integer', required: true, description: 'Completed runs recorded for this task.' },
    failCount: { type: 'integer', required: true, description: 'Runs that ended in an error.' },
    lastError: { type: 'string', required: true, description: 'Most recent error text; empty when the last run was clean.' },
    tags: { type: 'array', required: true, description: 'Free-form labels.', items: { type: 'string' } },
  },
} as const

const RUN_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    atMs: { type: 'integer', required: true, description: 'When the run was recorded, epoch ms.' },
    atIso: { type: 'string', required: true, description: 'When the run was recorded, ISO text.' },
    taskId: { type: 'string', required: true, description: 'Task that ran.' },
    title: { type: 'string', required: true, description: 'Task title at run time.' },
    kind: { type: 'string', required: true, enum: ['prompt', 'shell', 'http'], description: 'Task kind at run time.' },
    outcome: {
      type: 'string',
      required: true,
      enum: ['ok', 'error', 'skipped', 'queued'],
      description: 'ok ran, error failed, skipped was too late, queued awaits the agent.',
    },
    detail: { type: 'string', required: true, description: 'Executor note, error text, or the queued prompt.' },
    durationMs: { type: 'integer', required: true, description: 'Wall time the run took.' },
  },
} as const

/** The tool-facing shape of a task. */
type TaskView = {
  id: string
  title: string
  schedule: string
  kind: TaskKind
  payload: string
  enabled: boolean
  nextRunMs: number
  nextRunIso: string
  lastRunMs: number
  lastRunIso: string
  runCount: number
  failCount: number
  lastError: string
  tags: string[]
}

/** The tool-facing shape of one run record. */
type RunView = {
  atMs: number
  atIso: string
  taskId: string
  title: string
  kind: TaskKind
  outcome: 'ok' | 'error' | 'skipped' | 'queued'
  detail: string
  durationMs: number
}

/** Project a stored task into the tool-facing shape. */
function projectTask(task: Task): TaskView {
  return {
    id: task.id,
    title: task.title,
    schedule: task.schedule,
    kind: task.kind,
    payload: task.payload,
    enabled: task.enabled,
    nextRunMs: task.nextRunMs,
    nextRunIso: iso(task.nextRunMs),
    lastRunMs: task.lastRunMs,
    lastRunIso: iso(task.lastRunMs),
    runCount: task.runCount,
    failCount: task.failCount,
    lastError: task.lastError,
    tags: task.tags,
  }
}

/** Project a stored run into the tool-facing shape. */
function projectRun(run: RunRecord): RunView {
  return {
    atMs: run.atMs,
    atIso: iso(run.atMs),
    taskId: run.taskId,
    title: run.title,
    kind: run.kind,
    outcome: run.outcome,
    detail: run.detail,
    durationMs: run.durationMs,
  }
}

/** Shorten text for one-line listings. */
function clip(text: string, limit = 120): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > limit ? `${flat.slice(0, limit - 1)}…` : flat
}

/** Error text for any thrown value. */
function failureMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Build a stable-enough task id from a title plus a counter. */
function makeId(title: string, existing: Set<string>): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'task'
  if (!existing.has(slug)) return slug
  let index = 2
  while (existing.has(`${slug}-${index}`)) index += 1
  return `${slug}-${index}`
}

/* ---------------------------------------------------------------------------------- */
/* Plan heuristics                                                                      */
/* ---------------------------------------------------------------------------------- */

/** A cadence suggestion the planner can emit. */
type PlanEntry = {
  title: string
  schedule: string
  kind: TaskKind
  payload: string
  rationale: string
}

/** Keyword to cadence mapping used by `sched_plan`. */
const PLAN_RULES: Array<{ pattern: RegExp; title: string; schedule: string; kind: TaskKind; rationale: string }> = [
  { pattern: /(test|测试|vitest|jest|回归)/i, title: 'Run the test suite', schedule: 'every 30m', kind: 'shell', rationale: 'Catches regressions shortly after they land.' },
  { pattern: /(lint|格式|format|oxlint|eslint)/i, title: 'Lint and format check', schedule: 'every 1h', kind: 'shell', rationale: 'Keeps style drift from accumulating.' },
  { pattern: /(typecheck|类型|tsc)/i, title: 'Typecheck the workspace', schedule: '0 */4 * * *', kind: 'shell', rationale: 'Type errors surface before review.' },
  { pattern: /(build|构建|打包)/i, title: 'Build the workspace', schedule: '0 3 * * *', kind: 'shell', rationale: 'Nightly build proves the tree still compiles.' },
  { pattern: /(依赖|depend|audit|安全|security)/i, title: 'Audit dependencies', schedule: '0 9 * * 1', kind: 'shell', rationale: 'Weekly supply-chain review.' },
  { pattern: /(文档|doc|readme|注释)/i, title: 'Review documentation drift', schedule: '0 10 * * 5', kind: 'prompt', rationale: 'Docs rot slowly; a weekly pass keeps them honest.' },
  { pattern: /(发布|release|changelog|版本)/i, title: 'Draft the changelog', schedule: '0 16 * * 5', kind: 'prompt', rationale: 'Friday draft ready for a Monday release.' },
  { pattern: /(备份|backup|快照|snapshot)/i, title: 'Snapshot state', schedule: '0 2 * * *', kind: 'shell', rationale: 'Nightly snapshot limits data loss.' },
  { pattern: /(审查|review|评审|代码质量)/i, title: 'Review outstanding diffs', schedule: '0 15 * * *', kind: 'prompt', rationale: 'Daily review keeps the queue short.' },
  { pattern: /(监控|metric|指标|health|健康|可用)/i, title: 'Check service health', schedule: 'every 15m', kind: 'prompt', rationale: 'Frequent checks catch outages early.' },
]

/** Default entries emitted when nothing in the objective matches a rule. */
const PLAN_FALLBACK: PlanEntry[] = [
  {
    title: 'Daily progress check-in',
    schedule: '0 9 * * *',
    kind: 'prompt',
    payload: 'Summarise what changed since yesterday and name the next concrete step.',
    rationale: 'A cheap daily anchor keeps a long-running objective moving.',
  },
  {
    title: 'Weekly review',
    schedule: '0 17 * * 5',
    kind: 'prompt',
    payload: 'Review the week: what shipped, what slipped, what to drop.',
    rationale: 'Weekly reflection prevents silent drift.',
  },
]

/**
 * Turn a stated objective into a concrete schedule plan.
 * Deterministic: the same objective always yields the same entries.
 */
export function planTasks(objective: string, cadence: string): PlanEntry[] {
  const hits: PlanEntry[] = []
  const seen = new Set<string>()
  for (const rule of PLAN_RULES) {
    if (!rule.pattern.test(objective)) continue
    if (seen.has(rule.title)) continue
    seen.add(rule.title)
    hits.push({
      title: rule.title,
      schedule: cadence.trim() !== '' ? cadence.trim() : rule.schedule,
      kind: rule.kind,
      payload: rule.kind === 'prompt'
        ? `${rule.title} — objective: ${clip(objective, 160)}`
        : `# ${rule.title} — objective: ${clip(objective, 160)}`,
      rationale: rule.rationale,
    })
  }
  if (hits.length === 0) {
    return PLAN_FALLBACK.map(entry => ({ ...entry, payload: `${entry.payload} (objective: ${clip(objective, 160)})` }))
  }
  return hits
}

/* ---------------------------------------------------------------------------------- */
/* Tool registration                                                                    */
/* ---------------------------------------------------------------------------------- */

/**
 * Register the scheduler tools and start the tick loop.
 * @param ctx - Registrant context carrying the tool registry.
 * @param config - Deployment's explicit configuration.
 * @param executors - Optional executor overrides (tests / host integration).
 */
export function apply(ctx: Context, config: Config, executors: Executors = {}): void {
  const zone = config.defaultZone
  const offset = zoneOffsetMinutes(zone)
  const stateDir = resolveStateDir(config.stateDir)
  const stateFile = join(stateDir, 'state.json')
  const historyLimit = Math.max(1, Math.trunc(config.historyLimit))
  const tickMs = Math.max(1_000, Math.trunc(config.tickMs))
  const maxLatenessMs = Math.max(0, Math.trunc(config.maxLatenessMs))
  const state = loadState(stateFile)

  /** Queue of prompts that came due and await the agent. */
  const pending: RunRecord[] = []

  /** Recompute one task's next fire time. */
  function reschedule(task: Task, fromMs: number): void {
    const { nextRunMs } = nextForSchedule(task.schedule, fromMs, offset)
    task.nextRunMs = nextRunMs
  }

  /** Record a run, trimming the history ring. */
  function record(run: RunRecord): void {
    state.history.push(run)
    while (state.history.length > historyLimit) state.history.shift()
  }

  /** Execute one task now, then reschedule it. */
  async function runTask(task: Task, nowMs: number): Promise<RunRecord> {
    const started = Date.now()
    let outcome: RunRecord['outcome'] = 'queued'
    let note = task.payload
    try {
      if (task.kind === 'prompt') {
        // Prompts are never executed here: they queue for the agent to drain.
        outcome = 'queued'
        note = task.payload
      } else {
        const executor = executors[task.kind]
        if (!executor) {
          outcome = 'skipped'
          note = task.kind === 'shell' && !config.allowShell
            ? 'shell tasks are disabled (set allowShell to enable)'
            : task.kind === 'http' && !config.allowHttp
              ? 'http tasks are disabled (set allowHttp to enable)'
              : `no executor registered for "${task.kind}"`
        } else {
          const result = await executor({ task, nowMs })
          outcome = result.outcome
          note = result.detail
        }
      }
    } catch (error) {
      outcome = 'error'
      note = failureMessage(error)
    }
    const durationMs = Date.now() - started
    const run: RunRecord = { atMs: nowMs, taskId: task.id, title: task.title, kind: task.kind, outcome, detail: note, durationMs }
    task.lastRunMs = nowMs
    task.runCount += 1
    if (outcome === 'error') {
      task.failCount += 1
      task.lastError = note
    } else if (outcome !== 'skipped') {
      task.lastError = ''
    }
    if (outcome === 'queued') pending.push(run)
    record(run)
    reschedule(task, nowMs)
    task.updatedAtMs = nowMs
    return run
  }

  /** One pass over the task table. */
  async function tick(nowMs: number): Promise<number> {
    let fired = 0
    for (const task of state.tasks) {
      if (!task.enabled) continue
      if (task.nextRunMs <= 0 || task.nextRunMs > nowMs) continue
      const late = nowMs - task.nextRunMs
      if (late > maxLatenessMs) {
        record({
          atMs: nowMs,
          taskId: task.id,
          title: task.title,
          kind: task.kind,
          outcome: 'skipped',
          detail: `missed by ${Math.round(late / 1000)}s (beyond maxLatenessMs)`,
          durationMs: 0,
        })
        reschedule(task, nowMs)
        continue
      }
      await runTask(task, nowMs)
      fired += 1
    }
    if (fired > 0) saveState(stateFile, state)
    return fired
  }

  /* ---------------------------------------------------------------- tools ---- */

  ctx.tools.register(defineTool({
    name: 'sched_plan',
    description:
      'Turn a stated objective into a concrete schedule plan. Give it the objective in plain ' +
      'language and it returns a set of candidate tasks — each with a title, a cron or `every <n><unit>` ' +
      'schedule, a task kind, a payload skeleton, and why that cadence helps. Nothing is created: ' +
      'review the plan, adjust anything you disagree with, then materialise the keepers with sched_create. ' +
      'Parameters: objective, cadence (optional override applied to every entry).',
    parameters: {
      objective: { type: 'string', required: true, description: 'What the user wants to keep happening, in plain language.' },
      cadence: { type: 'string', description: 'Force one schedule onto every planned task, e.g. "every 2h" or "0 9 * * *".' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          objective: { type: 'string', required: true, description: 'The objective as supplied.' },
          count: { type: 'integer', required: true, description: 'How many tasks the plan proposes.' },
          tasks: {
            type: 'array',
            required: true,
            description: 'Proposed tasks, ready to pass to sched_create.',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                title: { type: 'string', required: true, description: 'Short task label.' },
                schedule: { type: 'string', required: true, description: 'Proposed cron expression or interval.' },
                kind: { type: 'string', required: true, enum: ['prompt', 'shell', 'http'], description: 'Whether the task queues a prompt or runs a command.' },
                payload: { type: 'string', required: true, description: 'Payload skeleton for the task.' },
                rationale: { type: 'string', required: true, description: 'Why this cadence is proposed.' },
                scheduleValid: { type: 'boolean', required: true, description: 'Whether the proposed schedule parsed.' },
                scheduleReading: { type: 'string', required: true, description: 'English reading of the proposed schedule.' },
              },
            },
          },
        },
      },
      render: (_args, value) => {
        if (value.count === 0) return [{ type: 'text', text: 'No tasks proposed.' }]
        const lines = [`Proposed ${value.count} task(s) for: ${clip(value.objective, 160)}`]
        for (const entry of value.tasks) {
          lines.push(`- ${entry.title} [${entry.kind}] ${entry.schedule} (${entry.scheduleReading})`)
          lines.push(`    ${entry.rationale}`)
        }
        lines.push('', 'Create the ones you want with sched_create.')
        return [{ type: 'text', text: lines.join('\n') }]
      },
    },
    isConcurrencySafe: () => true,
    execute(args) {
      const entries = planTasks(args.objective, args.cadence ?? '')
      const tasks = entries.map(entry => {
        const parsed = parseSchedule(entry.schedule)
        return {
          ...entry,
          scheduleValid: parsed.valid,
          scheduleReading: parsed.valid
            ? (parsed.kind === 'interval' && parsed.interval
              ? `every ${Math.round(parsed.interval.ms / 1000)}s`
              : describeCron(parsed.cron as CronSpec))
            : `invalid: ${parsed.error}`,
        }
      })
      return Promise.resolve({ objective: args.objective, count: tasks.length, tasks })
    },
  }))

  ctx.tools.register(defineTool({
    name: 'sched_create',
    description:
      'Create a scheduled task. The schedule is a cron expression (five fields, macros like ' +
      '@daily, names like MON-FRI), or an interval written `every 30m` / `every 2h` / `every 1d`. ' +
      'Kinds: prompt queues the text for you to pick up via sched_due; shell runs a command line; ' +
      'http fetches a URL. shell and http stay disabled unless the deployment enables them, so a ' +
      'created task of those kinds still reports the refusal when it fires. ' +
      'Parameters: title, schedule, kind, payload, tags (optional), enabled (optional).',
    parameters: {
      title: { type: 'string', required: true, description: 'Short label for the task.' },
      schedule: { type: 'string', required: true, description: 'Cron expression, macro, or `every <n><unit>` interval.' },
      kind: { type: 'string', enum: ['prompt', 'shell', 'http'], description: 'Task kind; defaults to prompt.' },
      payload: { type: 'string', description: 'Prompt text, command line, or URL; defaults to the title.' },
      tags: { type: 'array', description: 'Optional labels.', items: { type: 'string' } },
      enabled: { type: 'boolean', description: 'Start enabled; defaults to true.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          valid: { type: 'boolean', required: true, description: 'Whether the task was created.' },
          error: { type: 'string', required: true, description: 'Why creation failed; empty on success.' },
          task: { ...TASK_SCHEMA, required: true, description: 'The created task.' },
        },
      },
      render: (_args, value) => {
        if (!value.valid) return [{ type: 'text', text: `Task not created: ${value.error}` }]
        const task = value.task as unknown as { id: string; title: string; schedule: string; nextRunIso: string }
        return [{
          type: 'text',
          text: `Created "${task.title}" (${task.id}) on ${task.schedule}; next run ${task.nextRunIso || 'unschedulable'}.`,
        }]
      },
    },
    isConcurrencySafe: () => true,
    execute(args) {
      const schedule = args.schedule.trim()
      const parsed = parseSchedule(schedule)
      if (!parsed.valid) {
        return Promise.resolve({ valid: false, error: `schedule: ${parsed.error}`, task: projectTask({
          id: '', title: args.title, schedule, kind: 'prompt', payload: '', enabled: false,
          createdAtMs: 0, updatedAtMs: 0, lastRunMs: 0, nextRunMs: -1, runCount: 0, failCount: 0, lastError: '', tags: [],
        }) })
      }
      const nowMs = Date.now()
      const existing = new Set(state.tasks.map(task => task.id))
      const kind: TaskKind = args.kind ?? 'prompt'
      const task: Task = {
        id: makeId(args.title, existing),
        title: args.title.trim() === '' ? 'untitled task' : args.title.trim(),
        schedule,
        kind,
        payload: args.payload === undefined || args.payload === '' ? args.title : args.payload,
        enabled: args.enabled ?? true,
        createdAtMs: nowMs,
        updatedAtMs: nowMs,
        lastRunMs: 0,
        nextRunMs: -1,
        runCount: 0,
        failCount: 0,
        lastError: '',
        tags: args.tags ?? [],
      }
      reschedule(task, nowMs)
      state.tasks.push(task)
      saveState(stateFile, state)
      return Promise.resolve({ valid: true, error: '', task: projectTask(task) })
    },
  }))

  ctx.tools.register(defineTool({
    name: 'sched_list',
    description:
      'List the scheduled tasks with their schedule, enabled flag, next fire time, and run counters. ' +
      'Use it before creating anything to avoid duplicates, and after changing the schedule to confirm the ' +
      'new cadence. Parameters: enabledOnly (optional), tag (optional).',
    parameters: {
      enabledOnly: { type: 'boolean', description: 'Return only enabled tasks.' },
      tag: { type: 'string', description: 'Return only tasks carrying this tag.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          count: { type: 'integer', required: true, description: 'Number of tasks returned.' },
          enabledCount: { type: 'integer', required: true, description: 'How many of them are enabled.' },
          tasks: { type: 'array', required: true, description: 'Matching tasks.', items: TASK_SCHEMA },
        },
      },
      render: (_args, value) => {
        if (value.count === 0) return [{ type: 'text', text: 'No scheduled tasks.' }]
        const lines = [`${value.count} task(s), ${value.enabledCount} enabled:`]
        for (const raw of value.tasks) {
          const task = raw as unknown as { id: string; title: string; schedule: string; kind: string; enabled: boolean; nextRunIso: string; runCount: number; failCount: number }
          const flag = task.enabled ? 'on ' : 'off'
          lines.push(`- [${flag}] ${task.id} — ${task.title} (${task.kind}) ${task.schedule} → ${task.nextRunIso || 'unschedulable'} · runs ${task.runCount} fail ${task.failCount}`)
        }
        return [{ type: 'text', text: lines.join('\n') }]
      },
    },
    isConcurrencySafe: () => true,
    execute(args) {
      let tasks = state.tasks
      if (args.enabledOnly === true) tasks = tasks.filter(task => task.enabled)
      if (args.tag !== undefined && args.tag !== '') tasks = tasks.filter(task => task.tags.includes(args.tag as string))
      return Promise.resolve({
        count: tasks.length,
        enabledCount: tasks.filter(task => task.enabled).length,
        tasks: tasks.map(projectTask),
      })
    },
  }))

  ctx.tools.register(defineTool({
    name: 'sched_update',
    description:
      'Change an existing task: enable or disable it, rename it, reschedule it, or replace its payload. ' +
      'Only the fields you pass are touched. Rescheduling recomputes the next fire time from now. ' +
      'Parameters: id, and any of enabled, title, schedule, payload, tags.',
    parameters: {
      id: { type: 'string', required: true, description: 'Task id from sched_list.' },
      enabled: { type: 'boolean', description: 'Turn the task on or off.' },
      title: { type: 'string', description: 'New label.' },
      schedule: { type: 'string', description: 'New cron expression or interval.' },
      payload: { type: 'string', description: 'New prompt text, command, or URL.' },
      tags: { type: 'array', description: 'Replacement tag list.', items: { type: 'string' } },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          valid: { type: 'boolean', required: true, description: 'Whether the update applied.' },
          error: { type: 'string', required: true, description: 'Why it failed; empty on success.' },
          task: { ...TASK_SCHEMA, required: true, description: 'The task after the update.' },
        },
      },
      render: (_args, value) => {
        if (!value.valid) return [{ type: 'text', text: `Update failed: ${value.error}` }]
        const task = value.task as unknown as { id: string; schedule: string; enabled: boolean; nextRunIso: string }
        return [{ type: 'text', text: `Updated ${task.id}: ${task.schedule}, ${task.enabled ? 'enabled' : 'disabled'}, next ${task.nextRunIso || 'unschedulable'}.` }]
      },
    },
    isConcurrencySafe: () => true,
    execute(args) {
      const task = state.tasks.find(candidate => candidate.id === args.id)
      if (!task) {
        return Promise.resolve({ valid: false, error: `no task with id "${args.id}"`, task: projectTask({
          id: args.id, title: '', schedule: '', kind: 'prompt', payload: '', enabled: false,
          createdAtMs: 0, updatedAtMs: 0, lastRunMs: 0, nextRunMs: -1, runCount: 0, failCount: 0, lastError: '', tags: [],
        }) })
      }
      if (args.schedule !== undefined) {
        const parsed = parseSchedule(args.schedule)
        if (!parsed.valid) return Promise.resolve({ valid: false, error: `schedule: ${parsed.error}`, task: projectTask(task) })
        task.schedule = args.schedule.trim()
      }
      if (args.enabled !== undefined) task.enabled = args.enabled
      if (args.title !== undefined && args.title.trim() !== '') task.title = args.title.trim()
      if (args.payload !== undefined) task.payload = args.payload
      if (args.tags !== undefined) task.tags = args.tags
      task.updatedAtMs = Date.now()
      reschedule(task, task.updatedAtMs)
      saveState(stateFile, state)
      return Promise.resolve({ valid: true, error: '', task: projectTask(task) })
    },
  }))

  ctx.tools.register(defineTool({
    name: 'sched_remove',
    description:
      'Delete a scheduled task permanently. Pass dryRun:true to see what would be removed without ' +
      'touching the store. Parameters: id, dryRun (optional).',
    parameters: {
      id: { type: 'string', required: true, description: 'Task id from sched_list.' },
      dryRun: { type: 'boolean', description: 'Report the removal without applying it.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          valid: { type: 'boolean', required: true, description: 'Whether the task was removed (or would be).' },
          error: { type: 'string', required: true, description: 'Why it failed; empty otherwise.' },
          removed: { type: 'boolean', required: true, description: 'True when the task no longer exists.' },
          title: { type: 'string', required: true, description: 'Title of the removed task.' },
          remaining: { type: 'integer', required: true, description: 'Tasks left after the removal.' },
        },
      },
      render: (_args, value) => {
        if (!value.valid) return [{ type: 'text', text: `Remove failed: ${value.error}` }]
        return [{ type: 'text', text: `Removed "${value.title}". ${value.remaining} task(s) remain.` }]
      },
    },
    isConcurrencySafe: () => true,
    execute(args) {
      const index = state.tasks.findIndex(candidate => candidate.id === args.id)
      if (index < 0) return Promise.resolve({ valid: false, error: `no task with id "${args.id}"`, removed: false, title: '', remaining: state.tasks.length })
      const [gone] = state.tasks.splice(index, 1)
      if (args.dryRun !== true) saveState(stateFile, state)
      else state.tasks.splice(index, 0, gone)
      return Promise.resolve({ valid: true, error: '', removed: true, title: gone.title, remaining: state.tasks.length })
    },
  }))

  ctx.tools.register(defineTool({
    name: 'sched_run_now',
    description:
      'Fire a task immediately, out of band from its schedule, and record the attempt in history. ' +
      'Useful for testing a freshly created task. The task is rescheduled from now afterwards. ' +
      'Parameters: id.',
    parameters: {
      id: { type: 'string', required: true, description: 'Task id to run.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          valid: { type: 'boolean', required: true, description: 'Whether a run happened.' },
          error: { type: 'string', required: true, description: 'Why it failed; empty otherwise.' },
          run: { ...RUN_SCHEMA, required: true, description: 'The recorded run.' },
        },
      },
      render: (_args, value) => {
        if (!value.valid) return [{ type: 'text', text: `Run failed: ${value.error}` }]
        const run = value.run as unknown as { title: string; outcome: string; detail: string }
        return [{ type: 'text', text: `Ran "${run.title}": ${run.outcome} — ${clip(run.detail, 200)}` }]
      },
    },
    isConcurrencySafe: () => false,
    async execute(args) {
      const task = state.tasks.find(candidate => candidate.id === args.id)
      if (!task) {
        return {
          valid: false,
          error: `no task with id "${args.id}"`,
          run: projectRun({ atMs: 0, taskId: args.id, title: '', kind: 'prompt', outcome: 'skipped', detail: 'unknown task', durationMs: 0 }),
        }
      }
      const run = await runTask(task, Date.now())
      saveState(stateFile, state)
      return { valid: true, error: '', run: projectRun(run) }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'sched_due',
    description:
      'Drain the prompts that came due and are waiting for you. Scheduled prompt tasks queue their text ' +
      'here instead of running on their own, so this is how an autonomous schedule reaches the model: ' +
      'call it to see what the schedule wanted you to do. Passing clear:true empties the queue after ' +
      'reporting. Parameters: clear (optional).',
    parameters: {
      clear: { type: 'boolean', description: 'Remove the returned items from the queue.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          count: { type: 'integer', required: true, description: 'How many queued prompts were returned.' },
          items: { type: 'array', required: true, description: 'Queued prompts, oldest first.', items: RUN_SCHEMA },
        },
      },
      render: (_args, value) => {
        if (value.count === 0) return [{ type: 'text', text: 'Nothing queued: no scheduled prompt is waiting.' }]
        const lines = [`${value.count} queued prompt(s):`]
        for (const raw of value.items) {
          const item = raw as unknown as { title: string; atIso: string; detail: string }
          lines.push(`- ${item.title} (due ${item.atIso}): ${clip(item.detail, 240)}`)
        }
        return [{ type: 'text', text: lines.join('\n') }]
      },
    },
    isConcurrencySafe: () => false,
    execute(args) {
      const items = pending.map(projectRun)
      if (args.clear === true) pending.length = 0
      return Promise.resolve({ count: items.length, items })
    },
  }))

  ctx.tools.register(defineTool({
    name: 'sched_history',
    description:
      'Read the recent run log, newest last: which task fired, when, how it ended, and any error text. ' +
      'Use it to answer "did the schedule actually run?" and to spot a task that keeps failing. ' +
      'Parameters: limit (optional), taskId (optional).',
    parameters: {
      limit: { type: 'integer', description: 'How many records to return, newest last; defaults to 20.' },
      taskId: { type: 'string', description: 'Restrict to one task.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          count: { type: 'integer', required: true, description: 'Records returned.' },
          total: { type: 'integer', required: true, description: 'Records retained in the log.' },
          runs: { type: 'array', required: true, description: 'Run records, newest last.', items: RUN_SCHEMA },
        },
      },
      render: (_args, value) => {
        if (value.count === 0) return [{ type: 'text', text: `No runs recorded (${value.total} retained).` }]
        const lines = [`${value.count} of ${value.total} run(s):`]
        for (const raw of value.runs) {
          const run = raw as unknown as { atIso: string; title: string; outcome: string; detail: string }
          lines.push(`- ${run.atIso} ${run.title}: ${run.outcome}${run.detail ? ` — ${clip(run.detail, 160)}` : ''}`)
        }
        return [{ type: 'text', text: lines.join('\n') }]
      },
    },
    isConcurrencySafe: () => true,
    execute(args) {
      const limit = Math.max(1, Math.trunc(args.limit ?? 20))
      let runs = state.history
      if (args.taskId !== undefined && args.taskId !== '') runs = runs.filter(run => run.taskId === args.taskId)
      return Promise.resolve({
        count: Math.min(limit, runs.length),
        total: runs.length,
        runs: runs.slice(-limit).map(projectRun),
      })
    },
  }))

  /* ------------------------------------------------------------- lifecycle ---- */

  if (config.autoStart && typeof setInterval === 'function') {
    const timer = setInterval(() => {
      void tick(Date.now()).catch(() => undefined)
    }, tickMs)
    // Do not hold the process open just for the ticker.
    if (typeof (timer as { unref?: () => void }).unref === 'function') (timer as { unref: () => void }).unref()
    const disposable = ctx as unknown as { on?: (event: string, handler: () => void) => void }
    if (typeof disposable.on === 'function') disposable.on('dispose', () => clearInterval(timer))
  }
}
