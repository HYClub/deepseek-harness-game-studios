> **DSH 运行注意（由 `dsh-src/skill-notes/code-review.md` 注入）**
>
> - **规则文件要主动读，别等注入。** `rules-context.mjs` 钩子是在**写入/编辑之后**才注入匹配规则的；
>   本技能主要是"读代码 + 出评审"，不会触发写入，因此**Phase 1 必须自己读**
>   `.dsh/rules/INDEX.md` 与匹配目标路径的 `.dsh/rules/*.md`（例如 `src/gameplay/**` → `gameplay-code.md`、
>   `src/ui/**` → `ui-code.md`）。实测：不读规则的评审会漏掉只有规则才能发现的项。
> - **Phase 7 的专家评审只有主代理能发起。** DSH 默认 `subagent` 深度上限是 1：主代理委派专家正常，
>   但**子代理再委派会被拒绝**（`subagent depth 2 exceeds maxDepth 1`）。如果你自己是子代理：
>   把专家评审标成 **NOT ASSESSED**，并明确写出"因委派深度受限未运行"——**绝不要自己扮演专家下结论**
>   （本技能本来也禁止模拟专家裁决）。
> - 由此带来一个必须点明的事实：在配了引擎的项目上，若 Phase 7 无法运行，**本技能的最终裁决在结构上就是
>   NOT ASSESSED**（你亲自跑完的 Phase 1–6 结论仍可写成"评审者本人的发现"）。把这句话写进报告，
>   不要让读者以为过了全套。

# Lens: engine review by file type (Phase 7)

What the engine specialists checked, one block per file type. Use the blocks for
the file types under review and the configured specialists only: a specialist
that is `null`, empty or missing has no block here, and its files go to the
**Primary** block. For depth on one point, read that specialist's agent file by
heading (`.dsh/agents/<name>.md`), never whole.

Before any version-qualified claim, read `docs/engine-reference/<engine>/VERSION.md`
and grep `deprecated-apis.md` and `breaking-changes.md` there for the API. An API
the reference does not cover is marked unverified, never asserted from memory.

## Code files (`specialists.code`: `.gd`, `.cs`, `.cpp`, `.ts`/`.js`)

- **Frame-rate independence**: every movement, timer and rate in a per-frame
  callback is scaled by delta (`_process`/`_physics_process` delta, `Time.deltaTime`,
  `DeltaSeconds`, the frame's `dt`). A fixed step per frame is a defect.
- **Hot paths**: no allocation per frame (new arrays, dictionaries, strings,
  `new`, `instantiate()`, closures, LINQ, `get_node()`/`$Path`/`GetComponent`/`querySelector`
  lookups) inside update loops; cache in `_ready`/`@onready`/`Awake`/constructor.
- **Lifetime**: a node, actor or object that can be freed is checked before use
  (`is_instance_valid`, `IsValid`, null) when it is held past the frame it was
  fetched in: a stored reference to something freed elsewhere, a signal or
  callback that fires after `queue_free()`/`Destroy`.
- **Language idioms**: static typing (GDScript), no Godot 3 syntax (`yield`,
  string `connect`); Unity: no `Find` or `GetComponent` per frame, no boxing in
  hot paths; Unreal: `UPROPERTY` on every `UObject*` the GC must see; Web: no
  DOM work in the game loop.
- **Signals and events**: connected once, disconnected when the listener goes
  first; no synchronous call chains disguised as signals.

## Shader files (`specialists.shader`: `.gdshader`, `.hlsl`, `.shader`, `.usf`, shader graphs)

- Renderer and shader type fit the project (`shader_type`, render mode,
  Forward+/Mobile/Compatibility, URP/HDRP).
- Per-pixel cost: texture samples, branches on per-pixel values, loops with a
  variable count, `discard` on opaque surfaces, overdraw on transparent ones.
- Precision and range: division by a value that can reach zero, `pow` of a
  negative base, normalising a zero vector, unclamped values fed to colour.
- Uniforms have hints and sane defaults; time-based effects use the engine's
  `TIME` (or equivalent), never a CPU-side per-frame uniform update.

## UI files (`specialists.ui`: screens, widgets, HUD, menus)

- The UI reads game state through signals or a view model; it never owns or
  writes game state.
- Text comes from the string table, never hardcoded; room for longer
  translations.
- Input focus and navigation work without a mouse; pause and modal states
  restore what they changed.
- No per-frame rebuilds of labels or lists; update on change.

## Primary (engine architecture: scenes, node trees, lifecycle)

- Scene and node structure: ownership clear, no reaching up the tree
  (`get_parent().get_parent()`), no absolute paths to other scenes' nodes.
- Lifecycle hooks used for what they are for (`_ready` vs `_enter_tree`,
  `Awake` vs `Start`, `BeginPlay`); nothing relies on sibling order.
- Autoloads, singletons and managers hold no game state another system writes.
- Files the editor writes (`.tscn`, `.tres`, `.uid`, `.meta`, `.uasset`) are
  consistent with the scripts that use them.

## Limits

Each finding names file and line and quotes the code or gives the input that
triggers it. A spot that only looks wrong (a deliberate pattern, a guarded case)
is checked by enumerating its inputs before it is called a defect.
