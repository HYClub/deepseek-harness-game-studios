// Parity-harness fixture: same output as echo-stdin.mjs but a non-zero exit code.
import { readFileSync } from 'node:fs';

process.stdout.write(readFileSync(0, 'utf8'));
process.exit(1);
