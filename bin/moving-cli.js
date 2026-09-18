#!/usr/bin/env node
import { run } from '../src/cli.js';
// Pipelines such as `... | head` may close early; do not emit a stack trace.
process.stdout.on('error', error => { if (error.code === 'EPIPE') process.exit(0); throw error; });
process.exitCode = await run(process.argv.slice(2));
