#!/usr/bin/env bun

export * from "./project-bootstrap";

import { runCreateProject } from "./project-bootstrap";

if (import.meta.main) {
  const code = await runCreateProject(process.argv.slice(2));
  process.exit(code);
}
