#!/usr/bin/env bun

export * from "./project-bootstrap";

import { runSetupProject } from "./project-bootstrap";

if (import.meta.main) {
  const code = await runSetupProject(process.argv.slice(2));
  process.exit(code);
}

