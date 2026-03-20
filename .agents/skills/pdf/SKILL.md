---
name: pdf
description: Handle PDF workflows including merge, split, extract, OCR, watermarking, forms, and PDF generation. Use when PDFs are a primary input or output.
---

Use this skill for any PDF manipulation task.

Tool routing:
- Merge and basic structure edits: `pypdf`
- Text and table extraction: `pdfplumber`
- PDF generation: `reportlab`
- CLI merge and repair: `qpdf`
- OCR for scanned PDFs: `pytesseract`

Guidance:
- Detect whether the PDF is text-based or scanned before choosing tools
- Treat form filling as two modes: fillable fields vs overlay annotation
- Prefer extraction plus validation over assuming layout correctness
- Reach for advanced tools only when baseline libraries are insufficient
