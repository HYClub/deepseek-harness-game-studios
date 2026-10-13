> **DSH 运行注意（由 `dsh-src/skill-notes/gate-check.md` 注入）**
>
> - **上游在 `minimal` 档自相矛盾，本移植没有改动上游内容**：`help` 明确写"`minimal` 路径没有阶段门禁、
>   永不提示 `/gate-check`"，而本技能的 `references/gate-systems-design.md` 又为 `minimal` 定义了一套缩减门禁
>   （"有内容的 brief = PASS"）。两者不可能同时为真。
> - **DSH 侧的处理原则**（避免在矛盾里"选边"造成静默放行）：
>   1. 若证据无法验证（例如 `qa.level: minimal` + `review_mode: solo` 下只剩"brief 非空"这一条），
>      **输出 CONCERNS / NOT ASSESSED，不要输出 PASS**；本技能 §4 的"绝不假设 PASS"优先于任何缩减行。
>   2. **不要在被判 PASS 时顺手写 `project.stage`**：`help` 的下一步映射不认那个阶段，会立刻自相矛盾。
>      先把这个矛盾报告给用户，由用户决定以哪一侧为准。
>   3. 报告里点明"本次门禁在 `minimal` 档下实际只校验了哪些东西"，别让读者以为过了全套检查。
> - `performance.enforce: block` 与 `testing.strict.*: true` 分支在本次移植验收里**未实测**；
>   用到这两条时请把结论至少降一档（NOT ASSESSED）并说明。

> Gate definition, loaded by `/gate-check` for the TARGET PHASE ONLY.
> Never load the other five — one gate applies per invocation.


# Gate: Concept → Systems Design


**Required Artifacts:**
- [ ] `design/gdd/game-concept.md` exists and has content
- [ ] Game pillars defined (in concept doc or `design/gdd/game-pillars.md`)
- [ ] Visual Identity Anchor section exists in `design/gdd/game-concept.md` (from brainstorm Phase 4 art-director output)

**Recommended (not blocking):**
- [ ] Concept prototype exists in `prototypes/` with a REPORT.md showing PROCEED verdict
      (`/prototype [core-mechanic]`) — skipping this means GDDs may be written for an
      idea that hasn't been played. Acceptable if the concept is proven by other means.

**Quality Checks:**
- [ ] Game concept has been reviewed (`/design-review` verdict not MAJOR REVISION NEEDED)
- [ ] Core loop is described and understood
- [ ] Target audience is identified
- [ ] Visual Identity Anchor contains a one-line visual rule and at least 2 supporting visual principles

## Workflow tier reductions

The checklist above is the **`full` baseline**. At lower tiers apply the
reduction for the resolved tier; items not named keep their status above.
Reductions only ever *relax* a requirement — `workflow_overrides` is the
only thing that adds one.

- **`full`** — game-concept.md + pillars + Visual Identity Anchor all required
- **`standard`** — pillars + Visual Identity Anchor → recommended; `game-concept.md` stays required
- **`minimal`** — gate target is **`design/game-brief.md`** (not `game-concept.md`); the GDD / pillars / Visual Identity Anchor checks **drop** (a brief with content = PASS). `/brainstorm` writes `design/game-brief.md` at this tier (Option A); `game-concept.md` remains the `standard`/`full` concept doc.
