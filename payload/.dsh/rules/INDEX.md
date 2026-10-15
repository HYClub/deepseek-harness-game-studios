# 路径规则索引（由 tools/build-dsh.mjs 生成）

上游运行时用规则文件的 `paths:` frontmatter 自动施加这些标准；DSH 没有该机制，
因此改由本索引 + `AGENTS.md` 的约定落实：**在编辑匹配路径的文件之前，先读对应规则文件。**

| 规则文件 | 适用路径 |
| --- | --- |
| `.dsh/rules/agent-memory.md` | `.dsh/agent-memory/**` |
| `.dsh/rules/ai-code.md` | `src/ai/**`<br>`Assets/**/{AI,Ai,ai}/**/*.cs`<br>`Source/**/{AI,Ai,ai}/**/*.{h,cpp}` |
| `.dsh/rules/data-files.md` | `assets/data/**/*.json`<br>`Assets/**/{Data,data}/**/*.json`<br>`Content/**/{Data,data}/**/*.json` |
| `.dsh/rules/design-docs.md` | `design/gdd/**` |
| `.dsh/rules/engine-code.md` | `src/core/**`<br>`Assets/**/{Core,core}/**/*.cs`<br>`Source/**/{Core,core}/**/*.{h,cpp}` |
| `.dsh/rules/gameplay-code.md` | `src/gameplay/**`<br>`Assets/**/{Gameplay,gameplay}/**/*.cs`<br>`Source/**/{Gameplay,gameplay}/**/*.{h,cpp}` |
| `.dsh/rules/narrative.md` | `design/narrative/**` |
| `.dsh/rules/network-code.md` | `src/networking/**`<br>`Assets/**/{Networking,networking,Network,network}/**/*.cs`<br>`Source/**/{Networking,networking,Network,network}/**/*.{h,cpp}` |
| `.dsh/rules/prototype-code.md` | `prototypes/**` |
| `.dsh/rules/shader-code.md` | `assets/shaders/**`<br>`**/*.gdshader`<br>`Assets/**/*.{shader,hlsl,cginc,compute,shadergraph}`<br>`Shaders/**`<br>`**/*.{usf,ush}` |
| `.dsh/rules/skill-authoring.md` | `.dsh/skills/**`<br>`.dsh/agents/**` |
| `.dsh/rules/test-standards.md` | `tests/**`<br>`Assets/Tests/**/*.cs`<br>`Source/**/Tests/**/*.{h,cpp}` |
| `.dsh/rules/ui-code.md` | `src/ui/**`<br>`Assets/**/{UI,Ui,ui}/**/*.cs`<br>`Source/**/{UI,Ui,ui}/**/*.{h,cpp}` |
