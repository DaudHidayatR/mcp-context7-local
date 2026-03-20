---
name: xlsx
description: Build and edit spreadsheet outputs while preserving spreadsheet logic. Use for XLSX, XLSM, CSV, TSV, and financial model style workbooks.
---

Use this skill when spreadsheets are the main artifact.

Core rule:
- Prefer Excel formulas over Python-computed hardcoded outputs

Workflow:
1. Use `openpyxl` for structure, formulas, and formatting
2. Save the workbook
3. Recalculate formulas
4. Check for broken references and formula errors

Modeling conventions:
- Keep inputs, formulas, cross-sheet links, and external links visually distinct
- Mark key assumptions clearly
- Optimize for auditability, not just final values
