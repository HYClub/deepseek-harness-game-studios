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
export const inject = ['shell', 'sessionProjections']

const BRIDGE_PACKAGE = '@deepseek-ai/dsh-hooks-claude-code'

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
  const bases = [process.argv[1], process.execPath].filter(
    (value) => typeof value === 'string' && value.length > 0,
  )
  const failures = []
  for (const base of bases) {
    try {
      const require = createRequire(base)
      // Resolve the package entry (honouring its exports map) and load it from the
      // installation, so the bridge always matches the running dsh version.
      const entry = require.resolve(BRIDGE_PACKAGE)
      return require(entry)
    } catch (error) {
      failures.push(`${base}: ${error.code ?? error.message}`)
    }
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
 * The three hook events DSH has an event for but the official bridge does not map.
 *
 * Upstream's `hooks.json` declares nine events. The bridge covers six of them (SessionStart,
 * PreToolUse, PostToolUse, Stop, SubagentStart, SubagentStop) and has no code for the other three —
 * but the harness *does* emit events that mean the same thing, so the plugin runs those hook groups
 * itself:
 *
 * | upstream event | DSH event      |
 * |----------------|----------------|
 * | PreCompact     | `compact/start` |
 * | PostCompact    | `compact/end`   |
 * | Notification   | `approval/asked` |
 *
 * The payload is the upstream contract plus whatever the DSH event carries (spread through rather
 * than guessed), so a hook port reading `message`, `trigger` or anything else gets a real value.
 * Output is logged, never injected: DSH has no model-facing channel for these points, and the
 * upstream hooks of these three events act through files anyway.
 */
export const UNMAPPED_EVENTS = [
  {
    dshEvent: 'compact/start',
    point: 'PreCompact',
    extra: (payload) => ({ trigger: payload?.trigger ?? 'auto' }),
  },
  { dshEvent: 'compact/end', point: 'PostCompact', extra: () => ({}) },
  {
    dshEvent: 'approval/asked',
    point: 'Notification',
    extra: (payload) => ({
      message: `Approval requested for ${payload?.toolName ?? 'a tool'}`
        + `${typeof payload?.reason === 'string' && payload.reason.length > 0 ? ` — ${payload.reason}` : ''}`,
    }),
  },
]

/**
 * Run the hook groups of the events the bridge leaves unmapped.
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
  for (const mapping of UNMAPPED_EVENTS) {
    const groups = parsed?.hooks?.[mapping.point]
    if (!Array.isArray(groups) || groups.length === 0) continue
    disposers.push(ctx.on(mapping.dshEvent, async (payload, next) => {
      const session = payload?.session ?? payload?.agent?.session
      const body = {
        session_id: session?.header?.id ?? payload?.sessionId ?? '',
        transcript_path: '',
        cwd: session?.header?.cwd ?? projectDir,
        hook_event_name: mapping.point,
        ...(payload ?? {}),
        ...mapping.extra(payload),
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
              ctx.logger.warn(`dsgs-hooks: ${mapping.point} hook exited ${settled?.exitCode}: ${hook.command}`)
            }
          } catch (error) {
            ctx.logger.warn(`dsgs-hooks: ${mapping.point} hook failed: ${String(error)}`)
          }
        }
      }
      return next === undefined ? undefined : next()
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
  // Resolution order: explicit config, then the environment override, then an upward search
  // from the launch directory — so a plugin-manager install works with no configuration.
  const rawPath = typeof config.configPath === 'string' && config.configPath.length > 0
    ? config.configPath
    : (process.env.DSH_DSGS_HOOKS_CONFIG ?? findHookConfig(process.cwd()))
  if (typeof rawPath !== 'string' || rawPath.length === 0) {
    ctx.logger.warn('dsgs-hooks: no hook config found — set configPath or DSH_DSGS_HOOKS_CONFIG, or launch inside a project that has .dsh/hooks.json')
    return
  }
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



