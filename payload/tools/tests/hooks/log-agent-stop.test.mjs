/**
 * Tests for `dsh-src/hooks/log-agent-stop.mjs` (SubagentStop audit trail).
 *
 * Run: node tools/tests/hooks/log-agent-stop.test.mjs
 * Cases live in `_agent-suite.mjs`; this entry point pins the verb.
 * Fixtures are created in the OS temp directory and removed afterwards.
 */
import { runAgentHookSuite } from './_agent-suite.mjs';

runAgentHookSuite({ hookName: 'log-agent-stop.mjs', verb: 'Agent completed' });
