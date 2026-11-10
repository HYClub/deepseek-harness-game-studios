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

# /gate-check — Section 6: Update Stage on PASS

> Part of `/gate-check`. `SKILL.md` names when to read this file; the settings it
> resolved and the rules under its later headings still apply here.

## 6. Update Stage on PASS

When the verdict is **PASS** and the user confirms they want to advance, write the
new stage to BOTH `project.yaml` and the legacy `production/stage.txt`.

**On CONCERNS, the user may override — explicitly.** Do not offer the stage
write by default. If the user asks to advance anyway, list every concern and
ask: "The gate returned CONCERNS. Accept these risks — [list] — and may I update
`project.stage` in `project.yaml` to '[stage]' (and the legacy
`production/stage.txt`)?" Only on an explicit yes, add the `### Accepted Risks`
section to the gate report (each concern, accepted by the user, with the date)
and write the stage as below. **A FAIL is never overridden into a stage change, and
neither is NOT ASSESSED** — the blockers must be fixed, or the missing input
produced, and the gate re-run. That holds inside a CONCERNS verdict too: CONCERNS
outranks NOT ASSESSED in the verdict, but while any required check is NOT ASSESSED
the override is not offered. Name each such check and what would let it run.

### 6.1 Write the stage

After the yes, write both stage files with one command (quote a two-word stage):

```bash
"C:/Program Files/Git/bin/bash.exe" ".dsh/scripts/set-stage.sh" "<new-stage>"
```

It sets `project.stage` in `project.yaml`: it edits the `stage:` line, adds a
`project:` block after `framework:` when there is none, or creates the file from
the minimal template when there is no `project.yaml`. It keeps comments, other
keys and line endings. It also writes the legacy `production/stage.txt`, so hooks
that have not migrated still work, then reads both files back. It never seeds
`modes.review_mode`: `modes.rigor` supplies that, and an explicit value would pin
the review mode whatever the project's rigor.

### 6.2 Verify both writes

Show its `stage_yaml` and `stage_txt` rows. Exit 0 means both files hold the new
stage. Exit 4 means they disagree after writing: report the discrepancy to the
user and stop, because a split stage indicator corrupts future auto-detection.
Exit 5 means `project.yaml` has a layout the script will not edit (`project:` as
a one-line value): nothing was written, so say so and edit `project.yaml` with
the user's yes. Any other non-zero exit: report the message and stop.

**Always ask before writing**: "Gate passed. May I update `project.stage` in `project.yaml` to 'Production' (and the legacy `production/stage.txt`)?" — on an accepted CONCERNS override, the explicit yes above is that ask.

### 6.3 Rigor-fit check (advisory — never affects the verdict)

After the stage advance is confirmed, apply the raise trigger in
`.dsh/docs/settings-guidance.md § 4`: if the new stage is **Production** (or
later) while the resolved `modes.workflow` is `minimal` (the `rigor: minimal`
posture, from the config block above), add one line:

> "You're entering [stage] on `rigor: minimal` — most projects this size run
> `standard`. Revisit with `/project-settings modes.rigor=standard`?"

Offer it **once**, here at the gate. Route to `/project-settings` — never change the
setting yourself.

---
