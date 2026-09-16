# @qingshanjiluo/dsh-scheduler

DeepSeek runtime plugin: an **autonomous scheduled-task planner and runner**.
It is the actionable counterpart to `dsh-cron-manager` — where that plugin only
*explains* a cron expression, this one **plans, creates, fires, and records**
real scheduled tasks.

## What it does

- **Plans** — `sched_plan` decomposes a stated objective into a concrete set of
  candidate tasks, each with a schedule, a kind, a payload skeleton and a
  rationale. Nothing is created until you say so.
- **Creates** — `sched_create` materialises tasks with a cron expression, a
  macro (`@daily`), or an interval (`every 30m`, `every 2h`, `every 1d`).
- **Fires** — a background tick loop checks every `tickMs` and runs whatever
  came due, rescheduling each task afterwards.
- **Queues** — prompt tasks are never executed behind your back: they queue,
  and the agent drains them with `sched_due`. This is how an autonomous
  schedule reaches the model.
- **Persists** — tasks, counters and run history live in `state.json`, so the
  schedule survives restarts.

## Tools

| Tool | Purpose |
| --- | --- |
| `sched_plan` | Turn an objective into a reviewable multi-task schedule plan. |
| `sched_create` | Create a task (title, schedule, kind, payload, tags, enabled). |
| `sched_list` | List tasks with schedule, enabled flag, next fire time, counters. |
| `sched_update` | Enable/disable, rename, reschedule, or replace a payload. |
| `sched_remove` | Delete a task (`dryRun` supported). |
| `sched_run_now` | Fire a task out of band and record the attempt. |
| `sched_due` | Drain the prompts that came due and await the agent. |
| `sched_history` | Read the recent run log. |

## Task kinds

| Kind | Behaviour |
| --- | --- |
| `prompt` | Queues its text for the agent (`sched_due`). Always available. |
| `shell` | Runs a command line. **Refused unless `allowShell: true`.** |
| `http` | Fetches a URL. **Refused unless `allowHttp: true`.** |

Safe by default: installing the plugin cannot execute anything on its own.
A refused task is still recorded, as `skipped`, with the reason — so the
history tells you why nothing happened.

## Configuration

| Key | Default | Meaning |
| --- | --- | --- |
| `stateDir` | `''` | State directory. Empty → `<DSH_HOME|~/.dsh>/dsh-scheduler`. |
| `autoStart` | `true` | Run the background tick loop. |
| `tickMs` | `30000` | How often the loop looks for due tasks. |
| `defaultZone` | `UTC` | Zone used to read cron fields (fixed offsets only). |
| `historyLimit` | `200` | Run records retained. |
| `allowShell` | `false` | Permit `shell` tasks. |
| `allowHttp` | `false` | Permit `http` tasks. |
| `maxLatenessMs` | `3600000` | A task later than this is recorded as `skipped`. |

## Install

```bash
npx -y @deepseek-ai/dsh plugin --profile web add @qingshanjiluo/dsh-scheduler
```

Or, from a local checkout of this repository:

```bash
npx -y @deepseek-ai/dsh plugin --profile web add <path-to-this-directory>
```

The bundled `cordis.patch.yml` inserts the layer with the safe defaults above.

## Schedule syntax

- Five cron fields: `minute hour day-of-month month day-of-week`.
- Macros: `@hourly`, `@daily`/`@midnight`, `@weekly`, `@monthly`, `@yearly`.
- Field features: lists `1,15`, ranges `9-17`, steps `*/5` and `5-10/2`,
  `?` as a wildcard, `JAN-DEC` and `SUN-SAT` names, day-of-week `7` as Sunday.
- A leading seconds field is accepted and ignored.
- Intervals: `every 30s`, `every 15m`, `every 2h`, `every 1d`.
- Day-of-month and day-of-week combined follow standard cron: when both are
  restricted, **either** match fires.

## Development

```bash
npm run typecheck   # tsc --noEmit
npm test            # vitest run
npm run build       # tsc + tsdown → lib/
node scripts/load-smoke.mjs   # asserts the built artifact's plugin face
node scripts/e2e-tick.mjs     # real tick loop fires a due task and persists it
```

## License

MIT
