/**
 * dsgs-hooks — mount DSGS/Claude Code hook configs on DSH with DIRECT execution.
 *
 * ## Why this exists
 *
 * The official bridge (`@deepseek-ai/dsh-hooks-claude-code`) runs every hook command
 * through the harness shell service: `ctx.shell.run(ctx.shell.resolve(request))`.
 * That path is sandboxed, and `dsh-hook-protocol`'s runner converts ANY executor
 * failure into a neutral "allow" outcome. So on hosts where the sandboxed shell chain
 * cannot spawn the command, **every hook silently no-ops** — guards stop guarding with
 * no visible signal at all.
 *
 * Reproduced on Windows (DSH 0.2.0-rc.2): the hook spawn requests `workspace-write`,
 * the ACL backend derives its workspace from the *server launch directory*, and when
 * `%TEMP%` lives inside that directory it refuses:
 *
 *   Runner failure: windows-acl-run: Windows ACL temp root must be outside the workspace:
 *   workspace=C:\Users\user; temp=C:\Users\user\AppData\Local\Temp
 *
 * Launching `dsh web` from the project directory hides the bug; launching from the home
 * directory disables all hooks. That is not something a user should have to know.
 *
 * ## What this plugin does instead
 *
 * 1. Spawns hook commands directly with `node:child_process` (cmd.exe /d /s /c on
 *    Windows, /bin/sh -c elsewhere) — the same trust level Claude Code itself applies
 *    to hooks, and the only mode that cannot silently no-op. Spawn failures are turned
 *    into stderr text, never into a throw, so a real failure is visible.
 * 2. Pins the command's working directory to the **project that owns the config file**
 *    (`dirname(dirname(configPath))` by default, or an explicit `projectDir`). DSGS
 *    hook commands are project-relative (`node ".dsh/hooks/<name>.mjs"`), so this makes
 *    them resolvable no matter where the harness was launched from.
 * 3. Resolves the official bridge **from the running dsh installation** rather than
 *    declaring it as a dependency. A profile-local copy is what made the loader disable
 *    the row (`Plugin … is incompatible with dsh 0.2.0-rc.2: peerDependencies …`) when
 *    a third-party pack pinned an older bridge. Resolving from the install guarantees
 *    the bridge always matches the runtime.
 *
 * Everything else — payload shapes, matcher semantics, env substitution, decision
 * mapping, most-restrictive merge — stays owned by the official bridge and the shared
 * `@deepseek-ai/dsh-hook-protocol` library.
 *
 * @module dsgs-hooks
 */

import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { homedir } from 'node:os'
import { ensureMachineInstall } from './selfinstall.mjs'

const IS_WIN = process.platform === 'win32'

/** Cordis plugin name (shows up in loader diagnostics). */
export const name = 'dsgs-hooks'

/**
 * We call the bridge's `apply()` directly, so the loader never honours the bridge's own
 * `inject` list — this plugin must declare everything the bridge touches. `sessionProjections`
 * is read while handling subagent tool calls: without it Cordis throws
 * `cannot get property "sessionProjections" without inject` and the spawn fails.
 */
export const inject = ['shell', 'sessionProjections', 'workingDirectory']

const BRIDGE_PACKAGE = '@deepseek-ai/dsh-hooks-claude-code'

/**
 * The events the official bridge maps — its `CLAUDE_EVENTS` list in 0.2.1-rc.2. Kept here
 * so a configured group that falls outside it is reported at mount time instead of being
 * dropped without a trace (see the warning in `apply`).
 */
const BRIDGE_EVENTS = new Set([
  'SessionStart',
  'UserPromptSubmit',
  'PreToolUse',
  'PostToolUse',
  'Stop',
  'SubagentStart',
  'SubagentStop',
])


/**
 * Mount-stamp location: `<project>/.verify-logs/dsgs-hooks-mount.log`, derived from the
 * config path so it always lands in the project the hooks belong to.
 * @param {string} configPath - absolute hook config path
 * @returns {string} absolute stamp path
 */
function mountStampPath(configPath) {
  return join(dirname(configPath), '..', '.verify-logs', 'dsgs-hooks-mount.log')
}

/**
 * Load the official bridge from the running dsh installation.
 * @returns {object} the bridge module (`{ apply }`)
 * @throws when the installation copy cannot be located
 */
function loadBridge() {
  const bases = [process.argv[1], process.execPath, fileURLToPath(import.meta.url)].filter(
    (value) => typeof value === 'string' && value.length > 0,
  )
  const failures = []
  // The running dsh first, so the bridge always matches the dsh version that will emit the events.
  for (const base of bases) {
    try {
      const require = createRequire(base)
      const entry = require.resolve(BRIDGE_PACKAGE)
      return require(entry)
    } catch (error) {
      failures.push(`${base}: ${error.code ?? error.message}`)
    }
  }
  // Then the copy this package declares as a dependency: a dsh install that ships without the bridge
  // (a desktop build keeps it inside app.asar) would otherwise leave every hook unmounted.
  try {
    const require = createRequire(fileURLToPath(import.meta.url))
    const entry = require.resolve(BRIDGE_PACKAGE)
    return require(entry)
  } catch (error) {
    failures.push(`package: ${error.code ?? error.message}`)
  }
  throw new Error(
    `dsgs-hooks: cannot resolve ${BRIDGE_PACKAGE} from the dsh installation (${failures.join('; ')})`,
  )
}

/** Kill a child and, on Windows, the cmd.exe process tree underneath it. */
function killTree(child) {
  if (IS_WIN && child.pid !== undefined) {
    try {
      spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], {
        stdio: 'ignore',
        windowsHide: true,
      })
      return
    } catch {
      // fall through to the plain kill
    }
  }
  try {
    child.kill()
  } catch {
    // already gone
  }
}

/**
 * Build the direct-execution shell view the protocol runner consumes:
 * `shell.run(shell.resolve(request))` with
 * `request = { command, timeoutMs?, stdin?, signal?, workdir?, env? }`
 * returning `{ exitCode, stdout: { text }, stderr: { text } }`.
 *
 * @param {object} ctx - cordis context (used for observability logging)
 * @param {object} options - `{ projectDir, auditFile?, defaultTimeoutMs? }`
 * @returns {{ resolve: (request: object) => object, run: (spec: object) => Promise<object> }}
 */
export function createDirectShell(ctx, options = {}) {
  const projectDir = options.projectDir
  const auditFile = options.auditFile
  const defaultTimeoutMs =
    Number.isFinite(options.defaultTimeoutMs) && options.defaultTimeoutMs > 0
      ? Number(options.defaultTimeoutMs)
      : undefined

  function runOnce(spec) {
    return new Promise((settle) => {
      const command = String(spec?.command ?? '')
      const stdinData = typeof spec?.stdin === 'string' ? spec.stdin : ''
      const timeoutMs = Number.isFinite(spec?.timeoutMs)
        ? Number(spec.timeoutMs)
        : defaultTimeoutMs
      // Pinning cwd to the project is what makes project-relative hook commands
      // (`node ".dsh/hooks/<name>.mjs"`) resolve no matter where the harness was launched
      // from. A caller-supplied workdir is ignored unless the mount opts into it, because
      // the session workspace is typically the *launch* directory, not the project.
      const workdir =
        options.respectWorkdir && typeof spec?.workdir === 'string' && spec.workdir.length > 0
          ? spec.workdir
          : projectDir
      // `extraEnv` carries project policy into every hook process. `DSGS_ADVISORY=deny` is the one
      // in use: it escalates an advisory into a pre-action block, which is the only pre-execution
      // channel DSH delivers to the model. The hook's own `spec.env` still wins over it.
      const env = { ...process.env, ...(options.extraEnv ?? {}), ...(spec?.env ?? {}) }

      let child
      try {
        child = spawn(
          IS_WIN ? 'cmd.exe' : '/bin/sh',
          IS_WIN ? ['/d', '/s', '/c', command] : ['-c', command],
          {
            cwd: workdir,
            env,
            windowsHide: true,
            stdio: ['pipe', 'pipe', 'pipe'],
            // Without this, Node escapes the quotes inside a command like
            // `node ".dsh/hooks/x.mjs"` and cmd hands node a path with literal quote
            // characters ("Cannot find module 'C:\...\".dsh\hooks\x.mjs\"'").
            windowsVerbatimArguments: IS_WIN,
          },
        )
      } catch (error) {
        // Reported as stderr text on purpose: a throw becomes a silent "allow" upstream.
        settle({ exitCode: undefined, stdout: { text: '' }, stderr: { text: `dsgs-hooks: spawn threw: ${String(error)}` } })
        return
      }

      let stdoutText = ''
      let stderrText = ''
      let done = false
      let timer
      const startedAt = Date.now()

      const onAbort = () => killTree(child)
      try {
        spec?.signal?.addEventListener('abort', onAbort, { once: true })
      } catch {
        // signals are best-effort
      }

      const finish = (exitCode) => {
        if (done) return
        done = true
        if (timer !== undefined) clearTimeout(timer)
        try {
          spec?.signal?.removeEventListener('abort', onAbort)
        } catch {
          // ignore
        }
        if (auditFile !== undefined) {
          try {
            const head = command.replace(/\s+/g, ' ').slice(0, 120)
            const errHead = stderrText.replace(/\s+/g, ' ').slice(0, 160)
            appendFileSync(
              auditFile,
              `${new Date().toISOString()} | exit=${exitCode ?? 'ERR'} | ${Date.now() - startedAt}ms | ${head}${errHead ? ` | stderr: ${errHead}` : ''}\n`,
            )
          } catch {
            // an unwritable audit file must never affect hook execution
          }
        }
        settle({
          exitCode,
          stdout: { text: stdoutText },
          stderr: { text: stderrText },
        })
      }

      child.stdout?.on('data', (chunk) => {
        stdoutText += String(chunk)
      })
      child.stderr?.on('data', (chunk) => {
        stderrText += String(chunk)
      })
      child.on('error', (error) => {
        stderrText += `dsgs-hooks: spawn failed: ${String(error)}`
        finish(undefined)
      })
      child.on('close', (code) => finish(code === null ? undefined : code))

      if (timeoutMs !== undefined) {
        timer = setTimeout(() => {
          stderrText += `dsgs-hooks: hook timed out after ${timeoutMs}ms`
          killTree(child)
          finish(undefined)
        }, timeoutMs)
      }

      if (stdinData.length > 0) {
        try {
          child.stdin?.end(stdinData)
        } catch {
          // the command may not read stdin at all
        }
      } else {
        try {
          child.stdin?.end()
        } catch {
          // ignore
        }
      }
    })
  }

  return {
    /**
     * The bridge calls `resolve()` first; the direct backend needs no translation, but
     * this is where an invocation becomes visible before spawning.
     */
    resolve: (request) => {
      if (auditFile !== undefined) {
        try {
          appendFileSync(
            auditFile,
            `${new Date().toISOString()} | resolve | ${String(request?.command ?? '').replace(/\s+/g, ' ').slice(0, 120)}\n`,
          )
        } catch {
          // ignore
        }
      }
      return request
    },
    /**
     * The protocol runner uses `(await shell.execute(shell.resolve(request))).result()`
     * — a two-step handle, not a bare `run()`. Returning the wrong shape here is exactly
     * how a hook backend silently no-ops, so this pairing is load-bearing.
     */
    execute: async (spec) => {
      const pending = runOnce(spec)
      return { result: () => pending }
    },
  }
}

/**
 * Find the hook config without being told: walk up from `startDir` looking for
 * `<dir>/.dsh/hooks.json`. A plugin installed through the plugin manager has no way to know
 * the project path, and a default of `process.cwd() + '/.dsh/hooks.json'` breaks the moment
 * the harness is launched from anywhere else (a home directory, for instance).
 * @param {string} startDir - directory to start from
 * @returns {string | undefined} absolute config path, or undefined when none is found
 */
export function findHookConfig(startDir) {
  let dir = resolve(startDir)
  for (;;) {
    const candidate = join(dir, '.dsh', 'hooks.json')
    if (existsSync(candidate)) return candidate
    const parent = dirname(dir)
    if (parent === dir) return undefined
    dir = parent
  }
}

/**
 * The hook events the official bridge does not map — and what DSH actually emits for them.
 *
 * Upstream's `settings.json` declares EIGHT events; the bridge maps six of them
 * (SessionStart, PreToolUse, PostToolUse, Stop, SubagentStart, SubagentStop) plus
 * `UserPromptSubmit`, which DSGS does not configure. The remaining configured groups are
 * `Notification` and `PreCompact` (there is no `PostCompact` group upstream either).
 *
 * Checked against the live Host Event catalog (`cordis_inspect_query` → host Event →
 * `listEvents`, 2026-11-17). It matters because a wrong name does not throw: Cordis
 * accepts any string, so the listener is registered and **never fires** — a silent no-op,
 * which is exactly the failure this plugin exists to remove. Two names that look right
 * are not events at all:
 *
 *   - `compact/start`, `compact/end` — these are session-event TYPES
 *     (`dsh-session`'s `KNOWN_SESSION_EVENT_TYPES`), delivered by the single
 *     `session/event` feed. Subscribe to the feed and filter `event.type`.
 *   - `approval/asked` is a session-event TYPE (in dsh-session's catalogue, written by the approval
 *     service), not a Cordis event name. It arrives through `session/event`, which is an emit with no
 *     return value — so a notification hook has nothing to return and its `systemMessage` would only
 *     be logged. That is why `notify.mjs` stays dormant instead of riding that feed.
 */
export const SUBSCRIPTIONS = ['session/event']

/** Hook groups that cannot fire on this runtime, with the reason a reader needs. */
export const DORMANT_EVENTS = {
  Notification: 'DSH has no user-facing notification channel: `approval/asked` is a session-event type delivered on `session/event`, an emit with no return value, so notify.mjs\'s systemMessage would be logged and never shown',
  PostCompact: 'upstream never registers a PostCompact group either — post-compact.mjs is dormant by design, and recovery comes from SessionStart after a compaction',
}

/**
 * Event mappings this plugin runs itself.
 *
 * `hookConfigKey` is the upstream hook group; `event` must be a real Cordis event name
 * (see SUBSCRIPTIONS); `matches` decides whether this delivery is the one we want.
 */
export const UNMAPPED_HOOKS = [
  {
    hookConfigKey: 'PreCompact',
    event: 'session/event',
    // `session/event` delivers every session event; only the start of a compaction is ours.
    matches: (_session, event) => event?.type === 'compaction/start',
    extra: () => ({ trigger: 'auto' }),
  },
]

/**
 * Configured hook groups that nothing on this runtime can trigger.
 *
 * Exported so the rule is testable without booting a plugin: a group the bridge does not
 * map and this plugin does not run is dead weight, and the mount should say so.
 *
 * @param {Record<string, unknown>} configured - the `hooks` object of a hooks.json
 * @returns {Array<{ event: string, reason: string }>}
 */
export function unhandledHookEvents(configured) {
  const ours = new Set(UNMAPPED_HOOKS.map((mapping) => mapping.hookConfigKey))
  return Object.keys(configured ?? {})
    .filter((event) => !BRIDGE_EVENTS.has(event) && !ours.has(event))
    .map((event) => ({
      event,
      reason: DORMANT_EVENTS[event] ?? 'no hook implementation for this event on this runtime',
    }))
}

/**
 * Run the hook groups of the events the bridge leaves unmapped.
 *
 * Every mapping today rides the `session/event` feed: the listener is `(session, event)`, an emit,
 * so there is no `next()` to call and a trailing function argument must never be invoked. A future
 * mapping for a different event shape is refused loudly at registration instead of silently
 * registering a listener whose arguments it does not understand.
 *
 * @param {object} ctx - the real plugin context
 * @param {object} options - `{ shell, configPath, projectDir, defaultTimeoutMs? }`
 * @returns {Array<() => void>} disposers for the registered handlers
 */
export function registerUnmappedHooks(ctx, options) {
  const { shell, configPath, projectDir } = options
  let parsed
  try {
    parsed = JSON.parse(readFileSync(configPath, 'utf8'))
  } catch {
    return []
  }
  const disposers = []
  for (const mapping of UNMAPPED_HOOKS) {
    const groups = parsed?.hooks?.[mapping.hookConfigKey]
    if (!Array.isArray(groups) || groups.length === 0) continue
    if (mapping.event !== 'session/event') {
      ctx.logger.warn(`dsgs-hooks: no listener adapter for ${mapping.event} — ${mapping.hookConfigKey} stays dormant`)
      continue
    }
    disposers.push(ctx.on(mapping.event, async (session, event) => {
      if (!mapping.matches(session, event)) return
      const body = {
        ...(event ?? {}),
        session_id: session?.header?.id ?? event?.sessionId ?? '',
        transcript_path: '',
        cwd: session?.header?.cwd ?? projectDir,
        hook_event_name: mapping.hookConfigKey,
        ...mapping.extra(event),
      }
      for (const group of groups) {
        for (const hook of group.hooks ?? []) {
          if (hook.type !== undefined && hook.type !== 'command') continue
          try {
            const result = await shell.execute({
              command: hook.command,
              stdin: `${JSON.stringify(body)}\n`,
              timeoutMs: hook.timeout !== undefined ? hook.timeout * 1000 : (options.defaultTimeoutMs ?? 15000),
              workdir: projectDir,
              env: { CLAUDE_PROJECT_DIR: projectDir },
            })
            const settled = await result.result()
            if ((settled?.exitCode ?? 0) !== 0) {
              ctx.logger.warn(`dsgs-hooks: ${mapping.hookConfigKey} hook exited ${settled?.exitCode}: ${hook.command}`)
            }
          } catch (error) {
            ctx.logger.warn(`dsgs-hooks: ${mapping.hookConfigKey} hook failed: ${String(error)}`)
          }
        }
      }
    }))
  }
  return disposers
}

/**
 * Cordis plugin entry.
 * @param {object} ctx - cordis context
 * @param {object} config - `{ configPath?, projectDir?, auditFile?, defaultTimeoutMs? }`
 */
/** Machine-level self-install (payload + bootstrap skill), once per machine. Never throws. */
function maybeSelfInstall(ctx) {
  try {
    const here = fileURLToPath(new URL('.', import.meta.url))
    const home = process.env.DSH_HOME || join(homedir(), '.dsh')
    const report = ensureMachineInstall({ payloadDir: join(here, 'payload'), homeDir: home, log: (m) => ctx?.logger?.info?.(`[DSGS] ${m}`) })
    if (report.errors.length > 0) ctx?.logger?.warn?.(`[DSGS] machine-level install skipped: ${report.errors.join('; ')}`)
  } catch (error) {
    ctx?.logger?.warn?.(`[DSGS] machine-level install failed: ${String((error && error.message) || error)}`)
  }
}

export function apply(ctx, config = {}) {
  maybeSelfInstall(ctx);

  const mountHooks = (rawPath) => {
    const configPath = isAbsolute(rawPath) ? rawPath : resolve(process.cwd(), rawPath)
  // DSGS hook commands are project-relative (`node ".dsh/hooks/x.mjs"`), and the config
  // lives at <project>/.dsh/hooks.json, so the project is two levels above the file.
  const projectDir =
    typeof config.projectDir === 'string' && config.projectDir.length > 0
      ? config.projectDir
      : dirname(dirname(configPath))

  let bridge
  try {
    bridge = loadBridge()
  } catch (error) {
    ctx.logger.error(`dsgs-hooks: ${String(error)}`)
    return
  }

  const shell = createDirectShell(ctx, {
    projectDir,
    auditFile: typeof config.auditFile === 'string' ? config.auditFile : undefined,
    defaultTimeoutMs: config.defaultTimeoutMs,
    // `advisory: 'deny'` makes this project's advisory hooks block *before* the action instead of
    // warning after it — the only pre-execution channel DSH delivers to the model.
    extraEnv: typeof config.advisory === 'string' && config.advisory.length > 0
      ? { DSGS_ADVISORY: config.advisory }
      : undefined,
  })

  // A context view whose `shell` is the direct executor; every other property
  // (logger, effect, on, get, injects) passes straight through to the real context.
  const view = new Proxy(ctx, {
    get(target, key) {
      if (key === 'shell') return shell
      return target[key]
    },
  })

  // Only bridge-owned keys are forwarded: the bridge validates its own config surface.
  // `projectDir` matters beyond bookkeeping: the bridge substitutes `${CLAUDE_PROJECT_DIR}` in
  // command text with it and exports it as `CLAUDE_PROJECT_DIR` to every hook. Without it the
  // bridge falls back to the session cwd, so launching the harness from anywhere else would hand
  // hooks the wrong project root (upstream scripts that dereference that variable would break).
  const bridgeConfig = { configPath, projectDir }
  for (const key of ['pluginRoot', 'stderrSummaryMaxChars', 'defaultTimeoutMs']) {
    if (config[key] !== undefined) bridgeConfig[key] = config[key]
  }

  // PreToolUse is NOT taken over. Two live experiments (2026-10-10) settled whether a
  // pre-execution advisory can reach the model on this harness, and the answer is no:
  //   1. returning `additionalContexts` from `tools/pre-execute` — the hook ran (invocation audit
  //      shows `resolve` + `exit=0`), but `dsh-agent-loop` reads that field only from the
  //      **finalized tool result**, so a pre-execute value never enters the conversation. The
  //      harness's own `dsh-repeat-tool-reminder` binds `tools/post-execute` for the same reason.
  //   2. calling `agent.inject(context)` mid-execution (the API the bridge uses for SessionStart)
  //      — no observable effect either.
  // The bridge's behaviour is therefore left alone, and DSGS advisories are delivered on the
  // PostToolUse channel that does work (see `dsh-src/hooks/dsh-hooks.json`). Reproducing the
  // experiments: `tools/dsh-hooks-pretooluse-probe.yml` + `.verify-logs/pretooluse-probe-hooks.json`.
  bridge.apply(view, bridgeConfig)
  // The three events the bridge has no code for: the harness emits equivalents, so run their hook
  // groups from here (see UNMAPPED_EVENTS).
  registerUnmappedHooks(ctx, {
    shell,
    configPath,
    projectDir,
    defaultTimeoutMs: config.defaultTimeoutMs,
  })
  // A configured group that nothing can trigger is a silent no-op — the exact failure mode
  // this plugin exists to remove. Groups that are dormant by DESIGN are reported at info level
  // (they are documented behaviour); anything else is a real gap and is reported as a warning.
  try {
    const configured = JSON.parse(readFileSync(configPath, 'utf8')).hooks ?? {}
    for (const dead of unhandledHookEvents(configured)) {
      const line = `dsgs-hooks: "${dead.event}" is configured but cannot fire here — ${dead.reason}`
      if (DORMANT_EVENTS[dead.event] !== undefined) ctx.logger.info(line)
      else ctx.logger.warn(line)
    }
  } catch {
    // the bridge already parsed this file; a second failure here must not fail the mount
  }
  ctx.logger.info(`dsgs-hooks: mounted ${configPath} (direct execution, cwd=${projectDir})`)
  // A mount stamp on disk, so "did the plugin even load?" never depends on the log level
  // of whatever surface mounted it.
  try {
    mkdirSync(dirname(mountStampPath(configPath)), { recursive: true })
    appendFileSync(
      mountStampPath(configPath),
      `${new Date().toISOString()} | mounted configPath=${configPath} projectDir=${projectDir} cwd=${process.cwd()}\n`,
    )
  } catch {
    // diagnostics only
  }
  }

  // Resolution order: explicit config, the environment override, the launch directory, then the
  // first session's workspace. The last one matters on the desktop app: apply() runs from the app
  // folder (e.g. D:\DSH), which has no .dsh/hooks.json, while the session's workspace does.
  const configuredPath = typeof config.configPath === 'string' && config.configPath.length > 0
    ? config.configPath
    : (process.env.DSH_DSGS_HOOKS_CONFIG ?? '')
  if (configuredPath !== '') return mountHooks(configuredPath)
  const fromLaunch = findHookConfig(process.cwd())
  if (typeof fromLaunch === 'string' && fromLaunch.length > 0) return mountHooks(fromLaunch)

  ctx.logger.info('dsgs-hooks: no config in the launch directory; waiting for a session workspace')
  let mounted = false
  const disposers = []
  const sessionCwd = (session) => {
    try {
      const effective = ctx.workingDirectory?.get?.(session)
      if (typeof effective === 'string' && effective.length > 0) return effective
    } catch {
      // unpublished sessions have no effective directory yet; use the original header
    }
    const header = session?.header?.cwd
    return typeof header === 'string' ? header : ''
  }
  const trySession = (session) => {
    if (mounted) return
    const cwd = sessionCwd(session)
    if (typeof cwd !== 'string' || cwd.length === 0) return
    const found = findHookConfig(cwd)
    if (typeof found !== 'string' || found.length === 0) return
    mounted = true
    for (const off of disposers.splice(0)) if (typeof off === 'function') off()
    try {
      mountHooks(found)
    } catch (error) {
      mounted = false
      ctx.logger.error(`dsgs-hooks: mount failed: ${String(error)}`)
    }
  }
  // session/created fires before the agent exists, so the bridge's SessionStart hooks still run.
  disposers.push(ctx.on('session/created', (session) => trySession(session)))
  // A hot-mounted install, or a session that predates the plugin, gets another chance when its
  // next agent is created (the main agent on a restart, or a subagent later in the same session).
  disposers.push(ctx.on('agent/created', (payload) => trySession(payload?.agent?.session)))
}




