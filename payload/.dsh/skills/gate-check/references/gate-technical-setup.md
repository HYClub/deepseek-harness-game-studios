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


# Gate: Systems Design → Technical Setup


**Required Artifacts:**
- [ ] Systems index exists at `design/gdd/systems-index.md` with at least MVP systems enumerated
- [ ] All MVP-tier GDDs exist in `design/gdd/` and individually pass `/design-review`
- [ ] A cross-GDD review report exists in `design/gdd/` (from `/review-all-gdds`)

**Quality Checks:**
- [ ] All MVP GDDs pass individual design review (8 required sections, no MAJOR REVISION NEEDED verdict)
- [ ] `/review-all-gdds` verdict is not FAIL (cross-GDD consistency and design theory checks pass). A NOT ASSESSED verdict does not satisfy this: that review could not compare the GDDs, so this item is NOT ASSESSED for the gate
- [ ] All cross-GDD consistency issues flagged by `/review-all-gdds` are resolved or explicitly accepted
- [ ] System dependencies are mapped in the systems index and are bidirectionally consistent
- [ ] MVP priority tier is defined
- [ ] No stale GDD references flagged (older GDDs updated to reflect decisions made in later GDDs)

## Workflow tier reductions

The checklist above is the **`full` baseline**. At lower tiers apply the
reduction for the resolved tier; items not named keep their status above.
Reductions only ever *relax* a requirement — `workflow_overrides` is the
only thing that adds one.

- **`full`** — systems-index + all MVP GDDs at 8 sections + cross-GDD review report all required
- **`standard`** — MVP GDDs validated at the **5 standard sections** (+ conditional Formulas); cross-GDD review report → recommended
- **`minimal`** — **gate not applicable** — no gate between brief and code; auto-PASS with a note (see below)

> **`minimal` "not applicable" gate.** The Systems Design → Technical Setup gate
> has no meaning at `minimal` (no GDDs exist by design). Return a PASS verdict
> with the note: *"No design gate at minimal workflow — minimal skips the
> Systems Design phase; advancing brief → code."* The Section 6 stage write still
> applies on user confirmation. Do NOT flag absent GDDs as blockers. This is the
> named exception to Section 2b's rule that a gate with no required artifacts left
> may not PASS; the director panel does not run for it.
