/**
 * Tests for the plugin's unmapped-event wiring (`tools/dsh-plugin/index.js`).
 *
 * Run: node tools/tests/plugin/unmapped-events.test.mjs
 *
 * Regression guard for a bug that shipped: the plugin subscribed to `compact/start`,
 * `compact/end` and `approval/asked`. None of those are Cordis events — checked against the
 * live Host Event catalog (`cordis_inspect_query` → host Event → `listEvents`, 2026-11-17):
 * the catalog has `session/event` (whose `event.type` is `compaction/start` / `compaction/end`)
 * and `approval/request`, never the three names above. Cordis accepts any string, so the
 * listeners were registered and could never fire — silently, which is the one failure mode
 * this plugin exists to remove.
 *
 * What is pinned here:
 *   - every mapping subscribes to a declared, real event name (SUBSCRIPTIONS);
 *   - the invented names cannot come back;
 *   - `session/event` deliveries are filtered by `event.type`, so a compaction *end* does
 *     not run the PreCompact group;
 *   - a configured-but-unreachable group is reported, not dropped;
 *   - Notification / PostCompact carry a stated reason for staying dormant.
 */
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  DORMANT_EVENTS,
  SUBSCRIPTIONS,
  UNMAPPED_HOOKS,
  apply,
  registerUnmappedHooks,
  unhandledHookEvents,
} from '../../dsh-plugin/index.js'

const INVENTED = ['compact/start', 'compact/end', 'approval/asked']

let failed = 0
const test = (name, fn) => {
  try {
    fn()
    console.log(`  ok    ${name}`)
  } catch (error) {
    failed += 1
    console.log(`  FAIL  ${name}\n        ${error.message}`)
  }
}
const testAsync = async (name, fn) => {
  try {
    await fn()
    console.log(`  ok    ${name}`)
  } catch (error) {
    failed += 1
    console.log(`  FAIL  ${name}\n        ${error.message}`)
  }
}

test('every mapping subscribes to a declared event', () => {
  assert.ok(UNMAPPED_HOOKS.length > 0, 'no mapping at all — PreCompact would be dead again')
  for (const mapping of UNMAPPED_HOOKS) {
    assert.ok(
      SUBSCRIPTIONS.includes(mapping.event),
      `${mapping.hookConfigKey} subscribes to ${mapping.event}, which is not in SUBSCRIPTIONS`,
    )
  }
})

test('the invented event names are gone', () => {
  const used = UNMAPPED_HOOKS.map((mapping) => mapping.event)
  for (const name of INVENTED) {
    assert.ok(!used.includes(name), `${name} is not a Cordis event — it can only ever be a silent no-op`)
  }
})

test('a compaction start matches, an end does not', () => {
  const mapping = UNMAPPED_HOOKS.find((candidate) => candidate.hookConfigKey === 'PreCompact')
  assert.ok(mapping, 'PreCompact mapping missing')
  assert.equal(mapping.matches({}, { type: 'compaction/start' }), true)
  assert.equal(mapping.matches({}, { type: 'compaction/end' }), false)
  assert.equal(mapping.matches({}, { type: 'compaction/summary-error' }), false)
  assert.equal(mapping.matches({}, undefined), false)
})

test('dormant events carry a reason a reader can act on', () => {
  for (const event of ['Notification', 'PostCompact']) {
    assert.equal(typeof DORMANT_EVENTS[event], 'string', `${event} has no stated reason`)
    assert.ok(DORMANT_EVENTS[event].length > 40, `${event}'s reason is too short to be useful`)
  }
})

test('a configured group nothing can trigger is reported, not dropped', () => {
  const dead = unhandledHookEvents({
    SessionStart: [],
    PreToolUse: [],
    SubagentStop: [],
    Notification: [],
    PreCompact: [],
  })
  assert.deepEqual(dead.map((entry) => entry.event), ['Notification'])
  assert.match(dead[0].reason, /no user-facing notification channel/i)
  // Groups the bridge maps, and groups this plugin runs, must never be reported as dead.
  assert.deepEqual(unhandledHookEvents({ SessionStart: [], PreCompact: [], UserPromptSubmit: [] }), [])
})

await testAsync('session/event is filtered and the PreCompact group runs only on compaction/start', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'DSGS-unmapped-'))
  try {
    const configPath = join(dir, 'hooks.json')
    writeFileSync(configPath, JSON.stringify({
      hooks: {
        PreCompact: [{ matcher: '', hooks: [{ type: 'command', command: 'node .dsh/hooks/pre-compact.mjs', timeout: 5 }] }],
      },
    }), 'utf8')

    const listeners = new Map()
    const ctx = {
      on: (event, listener) => {
        listeners.set(event, listener)
        return () => listeners.delete(event)
      },
      logger: { warn: () => {}, info: () => {} },
    }
    const calls = []
    const shell = {
      execute: async (request) => {
        calls.push(request)
        return { result: async () => ({ exitCode: 0 }) }
      },
    }

    const disposers = registerUnmappedHooks(ctx, { shell, configPath, projectDir: dir })
    assert.equal(disposers.length, 1, 'PreCompact group was not registered')
    assert.ok(listeners.has('session/event'), 'subscribed to a name that is not an event')

    const listener = listeners.get('session/event')
    const session = { header: { id: 's-1', cwd: dir } }

    await listener(session, { type: 'compaction/end' })
    assert.equal(calls.length, 0, 'a compaction end ran the PreCompact group')

    // A session event is an emit, not a waterfall: a trailing function must never be invoked, or a
    // future waterfall mapping would swallow the caller's decision.
    let nextCalled = 0
    await listener(session, { type: 'compaction/end' }, () => { nextCalled += 1 })
    assert.equal(nextCalled, 0, 'a trailing function was called on a session event')

    await listener(session, { type: 'compaction/start', seq: 7 })
    assert.equal(calls.length, 1, 'a compaction start did not run the PreCompact group')
    const body = JSON.parse(calls[0].stdin.trim())
    assert.equal(body.hook_event_name, 'PreCompact')
    assert.equal(body.session_id, 's-1')
    assert.equal(body.cwd, dir)
    assert.equal(body.trigger, 'auto')
    assert.equal(body.seq, 7, 'the session event was not spread through')
    assert.equal(calls[0].workdir, dir)

    await listener(session, { type: 'compaction/start' }, () => { nextCalled += 1 })
    assert.equal(nextCalled, 0, 'a trailing function was called on a session event (start)')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

await testAsync('a desktop launch waits for the session workspace before mounting', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'DSGS-defer-'))
  const app = join(dir, 'app')
  const project = join(dir, 'project')
  mkdirSync(app, { recursive: true })
  mkdirSync(join(project, '.dsh'), { recursive: true })
  writeFileSync(join(project, '.dsh', 'hooks.json'), JSON.stringify({ hooks: {} }), 'utf8')
  const previous = process.cwd()
  process.chdir(app)
  try {
    const listeners = new Map()
    const ctx = new Proxy({
      logger: { info: () => {}, warn: () => {}, error: () => {} },
      on: (event, fn) => { listeners.set(event, fn); return () => listeners.delete(event) },
      effect: (fn) => { const d = fn(); return typeof d === 'function' ? d : () => {} },
      get: () => undefined,
      inject: () => {},
      // The desktop session header keeps the launch directory; the effective directory is the workspace.
      workingDirectory: { get: () => project },
    }, { get(target, key) { return key in target ? target[key] : () => {} } })
    apply(ctx, {})
    const onCreated = listeners.get('session/created')
    assert.equal(typeof onCreated, 'function', 'a launch without hooks.json must wait for a session')
    onCreated({ header: { cwd: app } })
    assert.ok(existsSync(join(project, '.verify-logs', 'dsgs-hooks-mount.log')), 'session workspace was not mounted')
  } finally {
    process.chdir(previous)
    rmSync(dir, { recursive: true, force: true })
  }
})

await testAsync('a hot-mounted install mounts when the next agent is created', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'DSGS-hot-'))
  const app = join(dir, 'app')
  const project = join(dir, 'project')
  mkdirSync(app, { recursive: true })
  mkdirSync(join(project, '.dsh'), { recursive: true })
  writeFileSync(join(project, '.dsh', 'hooks.json'), JSON.stringify({ hooks: {} }), 'utf8')
  const previous = process.cwd()
  process.chdir(app)
  try {
    const listeners = new Map()
    const ctx = new Proxy({
      logger: { info: () => {}, warn: () => {}, error: () => {} },
      on: (event, fn) => { listeners.set(event, fn); return () => listeners.delete(event) },
      effect: (fn) => { const d = fn(); return typeof d === 'function' ? d : () => {} },
      get: () => undefined,
      inject: () => {},
    }, { get(target, key) { return key in target ? target[key] : () => {} } })
    apply(ctx, {})
    const onAgent = listeners.get('agent/created')
    assert.equal(typeof onAgent, 'function', 'a hot install must keep a hook for the next agent')
    onAgent({ agent: { session: { header: { cwd: project } } } })
    assert.ok(existsSync(join(project, '.verify-logs', 'dsgs-hooks-mount.log')), 'hot install did not mount')
  } finally {
    process.chdir(previous)
    rmSync(dir, { recursive: true, force: true })
  }
})

console.log(`\nplugin/unmapped-events.test.mjs: ${failed === 0 ? 'all passed' : failed + ' failed'}`)
process.exit(failed === 0 ? 0 : 1)
