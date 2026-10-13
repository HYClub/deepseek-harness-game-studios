// Parity-harness fixture: echo stdin to stdout, exit 0. Used to self-test the comparator.
import { readFileSync } from 'node:fs';

process.stdout.write(readFileSync(0, 'utf8'));
