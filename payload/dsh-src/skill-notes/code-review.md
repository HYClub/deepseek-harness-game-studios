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
