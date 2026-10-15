> **来源**：这份报告由一次**角色卡委派实测**产出（DSH 子代理按 `.dsh/agents/qa-tester.md` 角色卡工作），
> 审的是 .smoke/studio 里最小闭环造出的 Stack Drop。保留它有两个用途：
> 证明"读角色卡 → 产出交付物"这条委派约定在 DSH 里真的可用；以及记录该实测的 QA 结论
> （它指出 smoke 报告里两处"证据撑不起结论"）。副本在 `.smoke/`（已 gitignore）。
# QA Review — Stack Drop (Epic `stack-drop`)

> **Date**: 2026-10-08
> **Reviewer**: qa-tester (delegated QA pass, read-only)
> **Scope**: `production/epics/stack-drop/` EPIC + story 001–003 (all marked **Complete**)
> **Mode**: `modes.rigor: minimal` → `qa.level: minimal`, `review_mode: solo`, `workflow: minimal` (resolved from `project.yaml` via `node tools/yaml-helper.mjs resolve_config`)
> **Verdict at a glance**:

| Story | Type | Gate | Verdict |
|---|---|---|---|
| 001 Landing resolution and width reduction | Logic | BLOCKING (waived at `qa.level: minimal`) | **PASS** |
| 002 Sliding block and single-button drop | Integration | BLOCKING (waived at `qa.level: minimal`) | **CONCERNS** |
| 003 Camera follow, score display, game over | UI | BLOCKING (screenshot **not** waived) | **CONCERNS** |

All three stories are marked Complete. This review does **not** re-open them on process
grounds — at `qa.level: minimal` the Logic and Integration test gates are advisory.
It records what is demonstrably verified, what is not, and one evidence claim that my
own measurements contradict.

---

## 1. What I read, and what I verified first-hand

**Read (documents)**: `production/epics/stack-drop/EPIC.md`; `story-001-landing-resolution.md`;
`story-002-sliding-block-and-drop.md`; `story-003-camera-score-gameover.md`;
`production/qa/evidence/stack-drop-evidence.md`;
`tests/playtest/stack-drop/story-002-sliding-block-and-drop.md`;
`design/game-brief.md`; `project.yaml`; `project.godot`; `production/session-state/active.md`;
`.dsh/rules/test-standards.md`.

**Read (implementation)**: `src/gameplay/landing_resolution.gd`; `src/gameplay/game_state.gd`;
`src/gameplay/stack_config.gd`; `src/ui/main.gd`; `src/ui/main.tscn`;
`config/stack_drop.cfg`; `tests/unit/gameplay/landing_resolution_scenarios.gd`.

**Executed / measured first-hand** (this is my evidence, not the story's):

1. **Re-ran the AC script** — exit **0**:
   `APPDATA=<ws>/.godot-user` + `Godot_v4.6.2-stable_mono_win64_console.exe --headless --path . -s res://tests/unit/gameplay/landing_resolution_scenarios.gd`
   → `=== 18 checks, 0 failed ===`. The story's claim of "18 checks, 0 failed" is **independently reproduced**.
2. **Pixel-measured the retained raw capture** (`production/qa/evidence/stack-drop/_raw/f00000000.png` … `f00000199.png`, 200 frames, 1280×720) with `System.Drawing`. Class colours are exact and separable: background `76,76,76`; placed block `92,92,107`; base block `51,51,64`; sliding block `255,115,12`.
   - **Placed-block extents (frame 199)**: `[360..919]`, `[566..919]`, `[648..919]`, `[854..919]` → widths 560 / 353.6 / 271.3 / 64.9 px. **Matches the playtest record's numbers exactly.**
   - **Sliding-block extent, every frame**: strictly rightward in all four observed slides, then the block is replaced. It never moves left in any of the 200 frames.
3. **Checked for the mapped input action in source**: `grep` for `drop_block|is_action|make_current|camera\.current` across `src/**` → **no matches**. The `drop_block` action defined in `project.godot` is never referenced by any script.

## 2. Story 001 — Landing resolution and width reduction (Logic)

Test evidence path required by the role card: `tests/unit/[system]/` — present at
`tests/unit/gameplay/landing_resolution_scenarios.gd`. Gate level BLOCKING, waived (advisory)
at `qa.level: minimal`.

| AC | Verdict | Basis |
|---|---|---|
| AC-1 overlap computed between moving block and block below | **PASS** | `Span.overlap_width` (landing_resolution.gd:43-45) is the intersection of the two intervals; exercised by script checks `overlap = 480.0`. |
| AC-2 survivor is exactly the intersection, overhang discarded | **PASS** | `resolve` returns `surviving_width = overlap` (landing_resolution.gd:99-110); script check `surviving width = 480.0` for spans 400+500 vs 420+500. |
| AC-3 next moving block's width equals surviving overlap | **PASS** | `game_state.gd:111-116` sets `_current_width` from `next_width(surviving_width, …)`, which returns the overlap unchanged for an imperfect drop; `_active_block.size.x = width` (main.gd:196); raw-frame widths 353.6 → 271.3 → 64.9 confirm. |
| AC-4 zero overlap ends the run, no smaller block produced | **PASS** (unit level) | `resolve` returns `MISSED` at `overlap <= 0` (:101); script checks `run ends on miss`. **Not** exercised through `GameState.drop_at` — see §5 gap G2. |
| AC-5 non-positive next width ends the run, never a zero/negative block | **PASS** (by code reading) | Zero overlap → `MISSED`; `0 < overlap < MIN_SURVIVING_WIDTH (1.0)` → `COLLAPSED` returning width 0.0 (:103-104); `overlap_width` clamps to `maxf(0.0, …)`. **No test exercises the `COLLAPSED` band** — see G3. |
| AC-6 placed block at the overlap's left edge | **PASS** | `survivor_left = maxf(incoming.left, below.left)` (:109); script check `survivor left = 500.0`; visually consistent in frame 199 (left edges 360 / 566 / 648 / 854). |
| AC-7 width reduction observable in returned state (width + height) | **PASS** | `Outcome.surviving_width` + `Outcome.tower_height`; script check `tower height = 132.0` (88 + 44). |

**Story 001 verdict: PASS.** The core function is correct, pure, and I reproduced its
evidence myself. Two caveats belong to the *record*, not the code:

- The **Test Evidence section still reads `Status: [ ] Not yet created`** although the
  substitute script exists. The Completion Notes document the deviation; the section
  itself was never updated. Traceability costs a reader a second pass.
- The script is a `SceneTree` driver with `_expect*` helpers, **not** a gdUnit4 suite.
  At `qa.level: minimal` this is a permitted substitute, and the deviation is disclosed.
  `.dsh/rules/test-standards.md` nonetheless specifies `[system]_[feature]_test.gd` with
  `test_[scenario]_[expected]` — a `resolve_*` / `_expect` naming convention would make
  the file defensible under the standard rather than merely excused from it.
- **Defect D3 (§7)**: `GameState.tower_height()` (game_state.gd:73-74) returns `_tower_top`,
  the absolute **Y coordinate**, while its docstring claims "height … measured from
  `base_top`". AC-7's *height* claim is carried by `Outcome.tower_height`, which is
  correct, so the AC holds; the getter is a latent defect (currently uncalled).

## 3. Story 002 — Sliding block and single-button drop (Integration)

Required evidence: `tests/integration/[system]/…` **OR** playtest doc. No `tests/integration/`
exists; the playtest record at `tests/playtest/stack-drop/story-002-sliding-block-and-drop.md`
is the substitute, which the story's own Test Evidence section permits.

| AC | Verdict | Basis |
|---|---|---|
| AC-1 spawns above tower top and slides **back and forth continuously** | **NOT ASSESSED** | Spawn-above-top: **PASS** — `_lane_y = top - spawn_gap` (main.gd:195). *Sliding*: **PASS** — measured monotonic motion, ~8 px/frame ≈ 420 px/s at 60 fps, matching `slide_speed`. **Reversal: NOT ASSESSED.** The code contains a limit-and-reverse branch (`main.gd:148-153`), but in all 200 retained frames the sliding block's extent moves only rightward and is then replaced; the capture never exercises a reversal. The playtest record's claim that it "revers[es] at the travel limits" is **not supported by the retained evidence I measured**. |
| AC-2 a single input action triggers the drop; that action is the only gameplay input | **PASS** (observable) / deviation | Exactly one gameplay input path exists: `_unhandled_input` → `_try_drop` (main.gd:115-128), fed by `_advance_demo` on the captured run. Both call the same `_try_drop`. **Deviation**: the mapped action `drop_block` (`project.godot`) and the story's instruction to "confirm the input-map API" are unused — the script accepts *any* key or mouse button instead of `Input.is_action_just_pressed("drop_block")`. Behaviour satisfies the AC; the mapping is dead config. |
| AC-3 second press while a block is already resolved does nothing | **PASS** | `_try_drop` early-returns when `not _state.is_active()`; `GameState.drop_at` likewise no-ops (:99-102). Script check `score unchanged after a post-failure drop = 0.0` covers the post-run case only. One playtest trial claims the per-interval driver advances the score by exactly one. There is **no falling state at all** — a drop resolves synchronously — so the criterion is satisfied by construction rather than demonstrated under contention. |
| AC-4 final horizontal position handed to Story 001's resolution; resulting width applied to the next block | **PASS** | `_state.drop_at(_active_block.position.x)` (main.gd:128) → `Span.new(drop_left, _current_width)` (game_state.gd:104); the returned width lands on `_active_block.size.x` (:196). Proven in raw frames: widths 560 → 353.6 → 271.3 → 64.9. |
| AC-5 next block spawns at the new tower top with the landing width | **PASS** | `_lane_y = top - spawn_gap`, `_active_block.position.y = _lane_y` (main.gd:195-197) with `size = (width, block_height)`. Notably the slider's **x is deliberately not reset**, so successive drops differ — visible in the frames. |
| AC-6 slide speed and spawn width are configuration values, not literals | **PASS** | `config/stack_drop.cfg` `[stack]` holds all seven values; `StackConfig.load_from_disk` reads them; no gameplay literal in `src/gameplay/**`. `main.gd` keeps only presentation literals (margin ratio, colours, camera rate), which is consistent with the story's scope. |
| AC-7 miss or zero width stops spawning and halts the loop | **PASS** | `_active = false` + `run_ended` on `MISSED`/`COLLAPSED`; `_process` stops sliding and the demo stops dropping; `_on_run_ended` hides the slider. Measured: the orange block is absent from frame 83 onward. **The `COLLAPSED` branch is never exercised** (G3). |

**Story 002 verdict: CONCERNS.** The loop demonstrably closes and the taper is real and
reproducible, but one acceptance criterion (AC-1's reversal) is recorded as observed when
the retained evidence does not contain it, and the input action named by the story is unused.

## 4. Story 003 — Camera follow, score display, game over (UI)

Required evidence: a retained screenshot of **each screen touched**, in `production/qa/evidence/`.
Present: `01-block-sliding.png`, `02-tower-tapering.png`, `03-game-over.png` (plus a 200-frame
`_raw/` capture). This gate is **not** waived at `qa.level: minimal`.

| AC | Verdict | Basis |
|---|---|---|
| AC-1 camera follows the tower top, keeping the active block in view | **PASS** (partly) | Camera movement is proven: in world space the tower top rose 132 px (frames 20→62) while its on-screen y moved far less, so the camera translated. `_follow_tower` targets `tower_top() - 360` (main.gd:158-160). "Keeping the active block in view" holds by construction because both the lane and the camera derive from the same `_tower_top`. What I cannot confirm is that *all* placed blocks stay on screen — the frames show the lower tower cropped at the bottom edge, which is expected for a following camera but is not specified either way. |
| AC-2 camera movement is smooth rather than snapping | **NOT ASSESSED** | A still cannot show motion quality. The `_raw/` frames do show intermediate camera positions (the tower's on-screen y differs frame to frame), which rules out a hard snap, but **smoothness is a temporal property that this evidence cannot establish**. Declared NOT ASSESSED by the story's own playtest record for the analogous slide feel, yet the story's Completion Notes claim **"6/6 passing (all observed on screen)"** — for AC-2 that claim is unsupported by any retained artifact. |
| AC-3 score shows current block count, updates on every landing | **PASS** | `_update_score_label()` runs in `_start_run` and in `_on_landed`; measured on screen: `SCORE 1` (frame 30), `SCORE 3` (frames 150, 199). |
| AC-4 on run end, a game-over state shows the final score | **PASS** | `03-game-over.png` shows `GAME OVER` / `SCORE 3` with the run halted; HUD and panel agree, so no stale value. |
| AC-5 score starts at zero visible on a fresh run, no stale carry-over | **NOT ASSESSED** | The zero state is **not in the retained evidence**. I read the code path (`_state.score()` is 0 at `GameState.begin`; `_update_score_label()` is called before any drop; `_start_run()` clears `_placed` and hides the game-over label), which supports the AC, but "observed on screen" is asserted in the Completion Notes and no screenshot shows a fresh run at `SCORE 0`. |
| AC-6 game-over screen reachable without a restart | **PASS** | The label lives in the same scene and is displayed by `_on_run_ended` (main.gd:202-205); nothing is torn down first. |

**Story 003 verdict: CONCERNS.** All three required screenshots exist and are genuine
(contents match the code's colours and geometry exactly). Two of six criteria are asserted
as observed but are not in the evidence, one of them (AC-5) being directly contradictory
to what the retained set shows.

## 5. Test-coverage gaps (what no test reaches)

- **G1 — `GameState` is not covered by an automated test at all.** Every check that touches
  the state machine (`_check_state_advances_score_and_speed`, `_check_second_drop_after_failure_is_ignored`)
  covers **success** and **already-ended**. The failure paths are never driven through it.
  `game_state.gd` is the file that decides whether the game ends; its end conditions are
  the least-tested code in the project.
- **G2 — A missed drop driven through the state machine is untested.** `MISSED` is covered in
  `LandingResolution.resolve`, and a post-failure drop is covered, but no check asserts
  "drop that misses → `is_active()` false, score unchanged, `run_ended` emitted". The
  playtest demonstrates it at the player level only.
- **G3 — `Result.COLLAPSED` is never exercised, anywhere.** No test, and no observed frame,
  reaches `0 < overlap < MIN_SURVIVING_WIDTH`. Story 001 AC-5 and Story 002 AC-7 both rest
  on this branch — the brief's second fail condition ("a block whose width would drop to
  zero also ends the run") has **no verification of any kind**. Since `MIN_SURVIVING_WIDTH`
  is 1.0 px, in a rendered run this band is effectively unreachable by play, so the branch
  is also unobservable by design; a unit check is the only way to cover it.
- **G4 — the slider's reversal branch is never executed in the retained run.** Because the
  demo forces a drop every 0.35 s while a full traverse takes longer, the block is always
  dropped mid-sweep. Nothing in `tests/` exists to cover it and `main.gd` has no test.
- **G5 — the `drop_block` input action is untested and unused.** No test, and no evidence,
  exercises the mapped action; grep finds no reference to it in `src/**`.
- **G6 — `StackConfig.load_from_disk`'s warning path is untested** (missing file, missing
  key). Admitted as out of scope by the story, but it is the mechanism that would silently
  fall back to defaults if `config/stack_drop.cfg` were renamed.
- **G7 — no UI/HUD test of any kind**, which is normal for a UI story at this tier; the
  screenshot gate is the substitute. I record it so the gap is not mistaken for coverage.

## 6. Evidence sufficiency — can these screenshots prove the criteria?

**Genuine and internally consistent.** `production/qa/evidence/stack-drop-evidence.md` records
the build (`4.6.2.stable.mono.official.71f334935`), the exact launch command, and the sandbox
workaround (`APPDATA` redirect) that any future run needs. I verified the launch string matches
`project.yaml`'s engine path. The three retained PNGs are real captures of this code: the
dominant colours are exactly the `COLOR_PLACED` / `COLOR_BASE` / `COLOR_ACTIVE` constants
converted to 8-bit, and the block spans match the playtest's measured widths to the pixel.

**But a screenshot set of this shape cannot carry some of the claims made on it:**

- It is **three stills plus a 200-frame dump**, i.e. no timeline. Anything about *rate,
  smoothness, or reversal* — Story 002 AC-1's "back and forth", Story 003 AC-2's "smooth" —
  is not establishable from it. Both stories' Completion Notes nevertheless report those
  criteria as observed.
- The `_raw/` directory is **raw, unreviewed, unnamed material** — no manifest, no frame-rate
  metadata, no indication which frames correspond to which criterion. It is useful (I used it
  to falsify a claim, and to confirm widths), but as an artifact it is a dump, not evidence.
  A named subset with the criterion each frame supports would cost little and carry much more.
- The evidence doc's **"Screens touched" table has two rows and three images**; it does not
  state which screen the *fresh-run / SCORE 0* state was captured on, because it never was.
  Story 003 AC-5 is therefore asserted, not evidenced.
- `_raw/`, `01-…png` and `02-…png` show the game **mid-run during a demo auto-play**, never a
  human at the keyboard. Everything observed is what the `--demo` driver does. That is a
  legitimate unattended-capture technique, but the input path a player uses
  (`_unhandled_input`) shares `_try_drop` with it — which I confirmed by reading — so the
  distinction is less risky here than the record implies. It would be stronger stated explicitly.

## 7. Defects and observations (reported, not fixed)

No bug files are created by this review: `production/qa/bugs/` does not exist in this project,
and at `qa.level: minimal` no bug-report gate is defined. These are recorded here for triage;
severity is kept at or below S2 per my role card, and anything worse would escalate to qa-lead.

- **D1 (S3, latent) — `GameState.tower_height()` returns a position, not a height.**
  `game_state.gd:73-74` returns `_tower_top` (absolute Y) while the docstring promises height
  from `base_top`. Currently uncalled, so no criterion breaks; the correct value is
  available as `Outcome.tower_height`. Fails loudly the day a HUD reads it.
- **D2 (S3, design) — the demo driver's fixed cadence, not the travel limit, is what ends the
  run.** `_advance_demo` (main.gd:166-180) drops every 0.35 s, so the block is always dropped
  mid-sweep. The run ends because the 64.9 px tower stops overlapping the drop points, which
  is AC-7 working correctly — but it means the reversal path is never executed, and it is the
  reason the AC-1 evidence is empty.
- **D3 (S4, doc) — `LandingResolution.next_width`'s `previous_width` parameter is documented as
  "the width of the block *before* it"** (:118-120) but is always passed `_config.start_width`
  (game_state.gd:115). With this game's numbers the difference is unobservable (surviving width
  never exceeds `start_width`), so this is a specification mismatch, not a live defect. Worth
  fixing because the parameter's *name* invites a future caller to pass the wrong thing.
- **D4 (S4) — `drop_at`'s `below` span is built from the same fields as the incoming span.**
  `game_state.gd:104-105` constructs `below` as `Span.new(_current_left, _current_width)`, i.e.
  the slider's own spawn width rather than an explicitly passed block-below width. For this
  loop they are the same number, so behaviour is correct and the taper is real. It is
  nonetheless the boundary Story 002 called its main risk: a caller that drops a *narrower*
  block onto a *wider* one gets the wrong block-below. If the width diverges in a later story,
  this becomes a real bug. No action needed now; flagging the coupling.

## 8. What I could not assess (stated plainly, not as a soft pass)

- **Story 002 AC-1's reversal** — the code has the branch; no retained artifact exercises it.
- **Story 003 AC-2 camera smoothness** — temporal property, stills cannot show it.
- **Story 003 AC-5 fresh-run `SCORE 0`** — not in the retained evidence.
- **Feel / timing / weight** of the slide, and whether the game is *fun* — outside a static
  review; the playtest record correctly defers this to `/team-qa`.
- **Anything requiring a live interactive run.** I re-ran the headless AC script (exit 0) and
  read the existing capture pixel by pixel. I did **not** launch the game and play it, so
  every statement about human-input behaviour rests on code reading plus the demo path.
- **Audio, performance, accessibility, save/persistence** — explicitly out of MVP scope, not
  reviewed.
- **Whether the game can be won or how long a run lasts** — no longevity data exists.

## 9. Recommended next steps, in priority order

1. Fix the three *evidence-accuracy* items before any gate rerun: amend Story 002's AC-1 and
   Story 003's AC-2/AC-5 Completion Notes to say **NOT ASSESSED** where the retained artifacts
   do not support "observed", or capture the four missing frames (SCORE 0 fresh run; a slider
   mid-reversal at each limit; a burst of consecutive frames showing camera interpolation).
2. Add state-machine failure tests to the AC script: a missed drop through `GameState`
   (assert `is_active()` false, score unchanged, `run_ended` emitted) and a `COLLAPSED` case
   with overlap inside `(0, 1.0)`. These are cheap and close G1–G3, the widest real gap.
3. Either wire `drop_block` to `Input.is_action_just_pressed("drop_block")` or delete the
   action from `project.godot` and record the deviation; dead input config contradicts
   Story 002 AC-2's stated evidence route.
4. Fix D1's docstring or return value before anything reads `tower_height()`.
5. Update Story 001's Test Evidence `Status` line, which still reads "Not yet created".

