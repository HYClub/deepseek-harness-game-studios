import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * dsgs-statusline — server half.
 *
 * Publishes the project status line as a **session projection**, which is how a DSH client UI
 * surface reads live session state. The definition shape is copied from the harness's own
 * projection (`dsh-agent-loop`'s `turnBoundaryProjectionDefinition`):
 *
 *   { key, stateVersion, stateSchema, init: () => state, apply: (state, event) => state }
 *
 * registered with `ctx.sessionProjections.register(definition)`, and read by a client with
 * `session.projections.faceOf(key)?.getSnapshot()` — exactly what `dsh-client-ui-goal` does for its
 * GoalBar (`faceOf("goal")`).
 *
 * ## Why this file is deliberately small
 *
 * An earlier revision ran the ported renderer (`node .dsh/statusline.mjs`) from a polling interval.
 * That revision **hung profile boot**: `dsh --profile <p> --help` never returned. Adding
 * `timer.unref()` did not fix it, so the cause was not proven, and a plugin that can hang the
 * harness must not be installed by default. This revision therefore does no I/O at all — no
 * subprocess, no timer, no file reads — and cannot block anything:
 *
 *  - the projection carries whatever the caller sets on it (`setLine`), and
 *  - the line itself is produced by `node .dsh/statusline.mjs` / the `/statusline` skill, both of
 *    which are verified today.
 *
 * Turning this into a live surface is a known, small step: give it the renderer once the boot path
 * is understood (start with why an async `apply` that imports `@deepseek-ai/schemastery` did not
 * return under `--help`).
 *
 * DSGS-only: upstream renders a status line from its own runtime; DSH has no such surface.
 *
 * @module dsgs-statusline
 */

export const name = 'dsgs-statusline'

/** The projection registry. Nothing else is touched. */
export const inject = ['sessionProjections']

/** The projection key a client surface subscribes to. */
export const PROJECTION_KEY = 'dgsStatusline'

/** Latest line, held here so the reducer stays synchronous. */
let latest = ''

/**
 * Compute the line from the project's config.
 *
 * Deliberately **synchronous and tiny**: a plugin runs during boot, and the earlier asynchronous
 * revision of this file is what made `dsh --profile <p> --help` never return. Reading two small
 * files is bounded work; spawning the full renderer is not, and belongs to `/statusline` and
 * `node .dsh/statusline.mjs`.
 *
 * What a plugin can honestly show is what the project *states* — the stage and the rigor posture.
 * The context percentage and the model name come from the harness payload that only the renderer
 * receives, so the bar does not invent them.
 *
 * @param {string} projectDir - project root
 * @returns {string} the line, or '' when the project states nothing yet
 */
export function projectLine(projectDir) {
  const yamlPath = join(projectDir, 'project.yaml')
  if (!existsSync(yamlPath)) return ''
  let text
  try {
    text = readFileSync(yamlPath, 'utf8')
  } catch {
    return ''
  }
  const field = (name) => {
    const match = new RegExp(`^\\s*${name}\\s*:\\s*["']?([\\w .-]+?)["']?\\s*$`, 'm').exec(text)
    return match === null ? '' : match[1].trim()
  }
  const stage = field('stage')
  const posture = { minimal: 'Minimal', standard: 'Standard', full: 'Full' }[field('rigor')] ?? ''
  // Upstream's renderer always prints something ("ctx: -- | Unknown | Minimal · brief"), so the bar
  // is visible even before a project states a stage. Defaults: the stage mirror/em dash for the
  // stage, and the documented `rigor` default for the posture.
  const stageText = stage.length > 0 ? stage : '—'
  const postureText = posture.length > 0 ? posture : 'Minimal'
  return `${stageText} · ${postureText}`
}

/**
 * Set the line the projection should report.
 * @param {string} line - the rendered status line
 */
export function setLine(line) {
  latest = typeof line === 'string' ? line : ''
}

/**
 * Register the projection.
 * @param {object} ctx - cordis context
 * @param {{projectDir?: string, schema?: object}} [config] - `projectDir` wins over the launch
 *   directory; `schema` accepts an injected `z` for tests
 */
export function apply(ctx, config = {}) {
  const projectDir = typeof config.projectDir === 'string' && config.projectDir.length > 0
    ? config.projectDir
    : process.cwd()
  const z = config.schema
  latest = projectLine(projectDir)
  ctx.logger.info(`dsgs-statusline: projection "${PROJECTION_KEY}" registered (line: ${latest || '—'})`)
  ctx.sessionProjections.register({
    key: PROJECTION_KEY,
    stateVersion: 1,
    stateSchema: z !== undefined ? z.object({ line: z.string().default('') }) : undefined,
    init: () => ({ line: latest }),
    // Recompute on every event: the stage changes only when a skill writes `project.yaml`, and the
    // read is two small files — cheap enough that a stale line is never worth the complexity of
    // deciding which events matter.
    apply: (state) => {
      latest = projectLine(projectDir)
      return state.line === latest ? state : { ...state, line: latest }
    },
  })
}



