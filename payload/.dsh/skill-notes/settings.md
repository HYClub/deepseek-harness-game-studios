> **DSH 运行注意（由 `dsh-src/skill-notes/settings.md` 注入）**
>
> - **上调 `rigor` 会让新的产物变成必需，而本技能不会告诉你这件事。** 实测：在只写过
>   `design/game-brief.md` 的项目里把 `minimal` 改成 `standard` 之后，门禁立刻要求
>   `design/gdd/game-concept.md`、pillars、Visual Identity Anchor、`systems-index.md`、`art-bible.md`
>   （`design/gdd/` 目录甚至还不存在），于是 `gate-check` 直接 FAIL。写配置时**必须附带一句提醒**：
>   列出新档位下新增的必需产物，并给出补齐路径（`/brainstorm` 在该档位重跑、`/map-systems`、`/art-bible`，
>   或先 `/adopt` 做一次迁移评估）。
> - **子代理不能问人**：本技能的写入批准是"必须人工确认"的一步，而 `ask_user_question` 在子代理里会失败
>   （`human interaction is unavailable while the calling agent is owned by another live agent`）。
>   被委派执行时，把它作为**待批准项返回给调用方**，不要自己批准自己、也不要绕开批准直接写。
> - 校验写入值用 `node tools/yaml-helper.mjs __call validate_enum_value <键> <值>`（返回 1 即越界）；
>   注意 `resolve_config --keys` 只认裸标签，`specialists.*` 这类键要用 `__call resolve_setting <dotted.path>`。
