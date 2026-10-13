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
