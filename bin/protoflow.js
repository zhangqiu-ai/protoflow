#!/usr/bin/env node
// Node can warn while it links the built-in modules a static import graph uses (Node 24 does for FORCE_COLOR with
// NO_COLOR), which happens before any module of that graph runs. So this entry only takes over Node warnings, with
// a module that imports nothing, and loads the CLI afterwards.
import '../src/cli-diagnostics.js';
await import('../src/cli.js');
