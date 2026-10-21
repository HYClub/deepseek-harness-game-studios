/**
 * Machine-level self-install for the DSGS plugin: on first load the plugin lays down
 * (a) the framework payload at `<home>/DSGS` and (b) the bootstrap skill at
 * `<home>/skills/dsgs-init/SKILL.md`, so that a user who has installed nothing but this
 * plugin can afterwards create an empty folder and say "初始化 DSGS".
 *
 * Contract: NEVER throws. A plugin that throws while loading takes the whole session down,
 * so every failure is collected into the returned report and surfaced as a warning instead.
 *
 * @module dsh-plugin/selfinstall
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, copyFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** Payload version stamped into `<home>/DSGS/package-version.txt`. */
export const INSTALL_VERSION = '0.1.9';

/** Paths never copied out of the framework (build output, scratch, caches). */
const SKIP = new Set(['node_modules', '.git', 'dist', '.smoke', '_external', '.verify-logs', '.local-backups', 'production/session-logs']);

/**
 * Recursively copy `from` into `to`, overwriting files (it is our own directory).
 * @param from - source directory.
 * @param to - destination directory.
 * @param onFile - called with the relative path of every file copied.
 */
function copyTree(from, to, onFile) {
  for (const entry of readdirSync(from)) {
    if (SKIP.has(entry)) continue;
    const src = join(from, entry);
    const dst = join(to, entry);
    const st = statSync(src);
    if (st.isDirectory()) {
      mkdirSync(dst, { recursive: true });
      copyTree(src, dst, onFile);
    } else {
      mkdirSync(to, { recursive: true });
      copyFileSync(src, dst);
      onFile?.(entry);
    }
  }
}

/**
 * Bootstrap-skill text, pointing at the installed payload.
 * @param payloadDir - absolute payload path to bake into the skill.
 * @returns the SKILL.md contents.
 */
export function bootstrapSkillText(payloadDir) {
  const init = join(payloadDir, 'tools', 'dsgs-init.ps1');
  return `---
name: dsgs-init
description: "初始化 DeepSeek Game Studios（DSGS）到当前工作区。用户说\\"初始化 DSGS\\"\\"安装 DSGS\\"\\"把 DSGS 装到这个目录\\"时用这个技能：它从机器级载荷铺框架（技能/代理/规则/钩子/工具/文档/指令），然后用户可以直接 /start。幂等，绝不覆盖已有文件。"
user-invocable: true
---

# DSGS 初始化（initialize DSGS in this workspace）

用户在**空文件夹**里说"初始化 DSGS"时执行本技能。机器级载荷已随插件安装就位：

- 载荷：\`${payloadDir}\`
- 初始化脚本：\`${init}\`

## 做什么

1. 先 dry run（**不要跳过**）：

   \`\`\`pwsh
   pwsh -NoProfile -File "${init}" -Target .
   \`\`\`

2. 复述要点，然后真的初始化（用户的"初始化 DSGS"就是授权）：

   \`\`\`pwsh
   pwsh -NoProfile -File "${init}" -Target . -Confirm
   \`\`\`

3. 报告写入了多少项、标记文件（\`.dsgs-installed.json\`）与下一步。

## 规则

- **幂等**：只补缺失文件，**绝不覆盖**已有文件。
- 工作区已经有 \`.dsh/skills\` 时不要重新初始化，直接提示用户 \`/start\`。
- 撤销：\`-Undo\`（只删它标记过的项）。
- 初始化后请用户**新开一个会话**再 \`/start\`（技能目录按会话装载）。

## 之后

\`/start\` → \`/setup-engine\` → \`/statusline\`。
`;
}

/**
 * `/start` guidance shell, installed at the user level so that `/start` works in ANY folder,
 * including a brand-new empty one. It initialises the workspace first when needed, then hands
 * over to the project's own `start` skill (read from disk, so no recursion through this shell).
 * @param payloadDir - absolute payload path to bake into the shell.
 * @returns the SKILL.md contents.
 */
export function startShimText(payloadDir) {
  const init = join(payloadDir, 'tools', 'dsgs-init.ps1');
  return `---
name: start
description: "DSGS 启动引导（引导壳）。在**任何**工作区开始 DeepSeek Game Studios 的首次引导：如果这里还没初始化 DSGS，就先自动初始化，然后按项目里的 start 技能继续。用户在任何文件夹（包括全新空文件夹）打 /start 时用这个。"
user-invocable: true
---

# /start（DSGS 引导壳）

## 1. 先判断：这个工作区初始化了吗

已初始化的标志（任一即可）：\`.dsh/skills/start/SKILL.md\` 存在，或 \`.dsgs-installed.json\` 存在。

- **已初始化** → 跳到第 3 步。
- **没初始化** → 第 2 步。

## 2. 初始化（用户的 /start 就是授权，但先 dry run）

\`\`\`pwsh
pwsh -NoProfile -File "${init}" -Target .
pwsh -NoProfile -File "${init}" -Target . -Confirm
\`\`\`

然后把结果（写入多少项、标记文件）用一两句告诉用户。

## 3. 转交项目里的真 /start

**直接读文件并严格照它执行**（不要再次调用 \`start\` 技能，否则会回到本壳）：

\`\`\`
<工作区>/.dsh/skills/start/SKILL.md
\`\`\`

按它的 Phase 1 检测、提问与后续步骤走，语言遵循 AGENTS.md 的输出语言约定。

## 4. 注意

- 本壳是**用户级**技能（机器级安装的一部分），只负责"初始化 + 转交"。
- 初始化刚写入的技能目录，**同一会话**未必立刻出现在技能列表里——但本壳第 3 步是**按文件路径读**，所以同一会话即可继续，无需新开会话。
- 撤销机器级安装：删除 \`${payloadDir}\` 与 \`~/.dsh/skills/dsgs-init\`、\`~/.dsh/skills/start\`。
`;
}
/**
 * Ensure the machine-level install exists (payload + bootstrap skill). Idempotent.
 * @param options - payload directory, DSH home, and an optional logger.
 * @returns a report; `errors` is non-empty when something could not be written.
 */
export function ensureMachineInstall({ payloadDir, homeDir, log = () => {} }) {
  const report = { payloadInstalled: false, payloadRefreshed: false, skillInstalled: false, skillRefreshed: false, errors: [], payloadDir, homeDir };
  try {
    if (!payloadDir || !existsSync(join(payloadDir, '.dsh', 'skills'))) {
      report.errors.push(`payload missing at ${payloadDir}`);
      return report;
    }
    const target = join(homeDir, 'dsgs');
    const stamp = join(target, 'package-version.txt');
    const skillsPresent = ['dsgs-init', 'start'].every((n) => existsSync(join(homeDir, 'skills', n, 'SKILL.md')));
    const fresh = skillsPresent && existsSync(join(target, '.dsh', 'skills')) && existsSync(stamp) && readFileSync(stamp, 'utf8').trim() === INSTALL_VERSION;
    if (!fresh) {
      // `target` is a managed directory: rebuild it so files removed from the payload disappear too.
      rmSync(target, { recursive: true, force: true });
      mkdirSync(target, { recursive: true });
      copyTree(payloadDir, target, null);
      writeFileSync(stamp, INSTALL_VERSION);
      report.payloadInstalled = !existsSync(stamp) ? true : true;
      report.payloadRefreshed = true;
      log(`payload installed at ${target}`);
    }
    for (const [name, text] of [['dsgs-init', bootstrapSkillText(target)], ['start', startShimText(target)]]) {
      const skillPath = join(homeDir, 'skills', name, 'SKILL.md');
      if (!existsSync(skillPath) || readFileSync(skillPath, 'utf8') !== text) {
        mkdirSync(join(homeDir, 'skills', name), { recursive: true });
        writeFileSync(skillPath, text);
        report.skillInstalled = true;
        report.skillRefreshed = true;
        log(`bootstrap skill written at ${skillPath}`);
      }
    }
  } catch (error) {
    report.errors.push(String((error && error.message) || error));
  }
  return report;
}













