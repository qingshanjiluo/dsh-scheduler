/**
 * Loads the built artifact and asserts it exports the Cordis function-plugin
 * face the runtime loader requires. Run after `npm run build`.
 * @module
 */
import assert from 'node:assert/strict'

const mod = await import(new URL('../lib/index.js', import.meta.url).href)

assert.equal(mod.name, 'dsh-scheduler', 'plugin name export')
assert.deepEqual(mod.inject, ['tools'], 'inject declares the tools service')
assert.equal(typeof mod.apply, 'function', 'apply is a function')
assert.ok(mod.Config, 'Config schema export present')

const registered = []
mod.apply(
  { tools: { register: def => registered.push(def) } },
  {
    stateDir: '',
    autoStart: false,
    tickMs: 30000,
    defaultZone: 'UTC',
    historyLimit: 200,
    allowShell: false,
    allowHttp: false,
    maxLatenessMs: 3600000,
  },
)
assert.deepEqual(
  registered.map(t => t.name).sort(),
  [
    'sched_create',
    'sched_due',
    'sched_history',
    'sched_list',
    'sched_plan',
    'sched_remove',
    'sched_run_now',
    'sched_update',
  ],
  'all eight tools register',
)

console.log('load-smoke: ok —', registered.length, 'tools registered from built artifact')
