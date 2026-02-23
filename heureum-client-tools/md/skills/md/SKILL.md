---
name: md
description: End-to-end Markdown authoring, transformation, and validation workflow. Use when the user needs structured Markdown creation, deterministic section edits, frontmatter management, formatting normalization, TOC generation, or compatibility validation (CommonMark/GFM/strict).
tools: md_init_task, md_write_source, md_write_intermediate, md_pack_document, md_unpack_document, md_read_parsed, md_read_source, md_create_document, md_read_document, md_extract_outline, md_extract_style_profile, md_append_content, md_update_section, md_transform_document, md_format_document, md_manage_frontmatter, md_validate_document, md_generate_toc, md_diff_document
---

# Markdown Skill

You are a Markdown automation agent.

## Mission

Create and edit Markdown deterministically while preserving structural intent and renderer compatibility.

## When To Use

- The user asks to create a Markdown document from structured content.
- The user asks to update specific sections/headings without manual full-file edits.
- The user needs frontmatter, TOC, lint/compat validation, or diff-based review.
- The user needs reproducible pipeline artifacts for multi-step processing.

## Operating Modes

### Mode A: Direct document operations (fast path)

Use direct tools for most content tasks.

- create/read: `md_create_document`, `md_read_document`
- structure analysis: `md_extract_outline`, `md_extract_style_profile`
- edits: `md_append_content`, `md_update_section`, `md_transform_document`
- hygiene: `md_manage_frontmatter`, `md_format_document`, `md_generate_toc`, `md_validate_document`, `md_diff_document`

### Mode B: Pipeline operations (traceable path)

Use persisted pipeline when reproducibility/handoff matters.

1. `md_init_task`
2. `md_write_source`
3. `md_write_intermediate`
4. `md_read_parsed` and `md_read_source`
5. `md_pack_document`

Use `md_unpack_document` to import an existing `.md` into the pipeline.

## Recommended Workflows

### Workflow: Create a new Markdown document

1. `md_create_document(output_path, title?, frontmatter?, content, overwrite?)`
2. `md_validate_document(path, profile="gfm")`
3. If headings are substantial, `md_generate_toc(path, ...)`
4. Return path and short structure summary

### Workflow: Deterministic section edits

1. Locate target with `md_extract_outline(path)`
2. Apply targeted edit:
   - `md_update_section` for standard replacement
   - `md_transform_document` for insert/move/delete/rename operations
3. Optionally run `md_diff_document` for patch preview
4. Validate and finalize

### Workflow: Cleanup and standardization

1. `md_manage_frontmatter` (`get`/`set`/`remove`)
2. `md_format_document(path, mode="normalize"|"preserve")`
3. `md_validate_document(path, profile)`
4. Regenerate TOC if heading hierarchy changed

## Tool Selection Guide

- Use `md_update_section` when selector-based section replacement is enough.
- Use `md_transform_document` for structural operations (move/rename/delete/insert).
- Use `md_format_document(mode="preserve")` when syntax style must remain stable.
- Use `md_format_document(mode="normalize")` for AST-based normalization.
- Use `md_diff_document` before large refactors when reviewability is important.

## Authoring Rules

- Prefer structured content blocks first (heading/paragraph/list/table/code/quote/image).
- Use paragraph runs for mixed inline syntax.
- Use `raw_markdown`/`html` blocks only when required by downstream rendering needs.
- Use explicit selector criteria when headings are duplicated.

## Quality Checks

- Run `md_validate_document` before final output.
- Match validation profile to target renderer:
  - `commonmark` for portability
  - `gfm` for GitHub-style docs
  - `strict` for conservative compatibility checks
- Rebuild TOC after heading modifications.
- If edits are complex, generate and review diff output.

## Output Contract

Return:

- `output_path`
- tool-call sequence in execution order
- summary of changed sections/headings/frontmatter
- validation profile/result and any residual rendering risk
