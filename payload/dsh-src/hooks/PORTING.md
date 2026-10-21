# 钩子移植约定（bash → Node）

## 为什么必须移植

`.claude/hooks/*.sh` 是上游的 bash 钩子（用 bash 写、靠 Python 读 YAML）。
在 DSH 会话里它们**跑不起来**，这是沙箱的既定边界，不是配置问题：

- Git Bash（MSYS2）无法在受限令牌下创建命名共享内存/信号管道：
  `couldn't create signal pipe, Win32 error 5` / `CreateFileMapping ... Win32 error 5`；
- WSL `bash.exe` 同样被拒（`E_ACCESSDENIED`）；
- Node 可以用，但**管道捕获子进程输出去会被拒**：
  `spawnSync git EPERM`（`stdio: 'pipe'` 形状）。

所以 DSH 侧一律用 Node 重写钩子，并用 `runtime.mjs` 的 `capture()`（重定向到临时文件，不经管道）。

## 契约

- 源文件：`dsh-src/hooks/<name>.mjs`（手写源）；生成物：`.dsh/hooks/<name>.mjs`（`tools/build-dsh.mjs` 复制）。
  基名与 `.claude/hooks/<name>.sh` 一致，转换器按基名决定 `hooks.json` 里启用哪些。
- 必须 `import { ... } from './runtime.mjs'`，用它的 `readInput` / `projectRoot` / `capture` /
  `resolveConfig` / `context` / `notifyUser` / `deny` / `ask` / `block` / `stop` / `run`。
- 入口统一写作：

  ```js
  import { run, readInput, projectRoot, context } from './runtime.mjs';

  run(async () => {
    const input = readInput();
    const root = projectRoot(input);
    // …检查…
    context(String(input.hook_event_name ?? 'SessionStart'), '要注入的上下文');
  });
  ```

- **绝不抛异常**：`run()` 兜底；钩子出错只能降级为「允许 + stderr 提示」，不能拖垮会话。
- 结构化输出的 `hookSpecificOutput.hookEventName` 必须等于实际触发的事件名，否则 DSH 会丢弃这些字段。
- 阻止用 `block(reason)`（exit 2，stderr 是模型看到的理由）；警告只写 stderr 并 exit 0。
- 只依赖 Node 内置模块；ESM；Windows 友好；输出写 UTF-8。

## 移植行为准则

1. **保留意图与阈值**：检查项、门槛、默认值、消息要点都要一致，不要"顺手放宽"。
2. **不许静默弱化闸门**：某个检查在 DSH 里做不到时，要么保留为失败并说明，要么显式跳过并在
   stderr 写明「本检查未运行」。拿不准就照抄原判断，别发明。
3. **上游运行时专有机制**：the upstream project-dir variable（用 `projectRoot()`）、`jq`（改用 Node）、
   `git` 调用（用 `capture()`）、`.claude/` 路径（改 `.dsh/`，但**项目资产路径不变**）。
4. **配置读取**用 `resolveConfig([...])`（对应 `resolve_config --keys`），不要自己解析 YAML。
5. **原文件读全**：以 `.claude/hooks/<name>.sh` 为准，包括注释里记录的历史踩坑——那些注释往往说明
   了为什么不能用更简单的写法。

## 子进程调用约定

沙箱禁管道、且没有可用的 `/bin/sh`，因此**所有子进程调用都走重定向到临时文件**。两个 helper：

| helper | 形态 | 何时用 |
|---|---|---|
| `hooks/_capture.mjs` → `runCommand(file, args)` / `git(args)` | argv 直接 spawn，**不经 shell** | **端口默认用这个**：没有引号重解析问题，跨平台 |
| `hooks/runtime.mjs` → `capture(commandLine)` | 整条 shell 命令行重定向（Windows 走 `cmd /d /s /c`） | 需要管道/重定向/多命令时；`resolveConfig()` 用它 |

> **历史注释提醒**：本目录下多个端口的文件头写着"`runtime.capture()` 在 Windows 上是死的"。
> 那是 2026-10-08 之前的状态——它原来的包装用了 cmd.exe 无法解析的 POSIX `{ cmd ; }` 语法，**已经修好**。
> 这些端口继续用 `runCommand` 是**架构选择**（argv 更安全），不是因为它坏着。别照那些注释"修"东西。

## 测试

放在框架仓库的钩子测试目录（`hooks/<name>.test.mjs`），用 `node:assert`，直接 `node <测试目录>/hooks/<name>.test.mjs` 运行。
至少覆盖：

- 正常通过路径（exit 0，无阻断输出）；
- 触发阻断/警告的路径（断言理由文本与退出行为）；
- 畸形或空 stdin；
- 缺 `project.yaml` / 空项目的降级路径。

测试通过临时目录构造 fixture，不要污染仓库；跑完清理。

## 交付报告（≤400 词）

1. 钩子名 + `.claude/hooks/<name>.sh` 的关键行号范围；
2. 保留的行为清单；
3. **有意丢弃或降级的行为 + 原因**（宁可写得难看也不要含糊）；
4. 测试文件路径与运行结果；
5. 尚未覆盖的风险点。

## 边界

不要修改 `.claude/**`、`.dsh/**`（生成物）、`tools/build-dsh.mjs`、`tools/check-dsh.mjs`、
`tools/yaml-helper.mjs`、`dsh-src/hooks/runtime.mjs`。你只新增/修改自己负责的
`dsh-src/hooks/<name>.mjs`，以及框架仓库里同目录下的测试（`hooks/<name>.test.mjs`）。



