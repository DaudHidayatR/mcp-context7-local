---
name: docx
description: Create, edit, and inspect DOCX documents with layout-safe defaults. Use for reports, memos, letters, templates, and Word file transformations.
---

Use this skill for any DOCX task.

Core approach:
- Creating: prefer the `docx` npm package
- Editing existing files: unpack XML, edit, then repack

Rules:
- Set US Letter page size instead of relying on defaults
- Use numbering config for bullets instead of raw Unicode bullets
- For tables, set both table column widths and cell widths
- Use clear shading values, not solid fill shortcuts
- Put page breaks inside paragraphs
- Set image type metadata explicitly

Defaults:
- Use author name `Claude` for tracked changes or comments unless the user specifies otherwise
- Prefer predictable, portable formatting over Word-only tricks
