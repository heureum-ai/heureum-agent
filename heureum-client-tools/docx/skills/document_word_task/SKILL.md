---
name: document_word_task
description: Comprehensive Word (.docx) authoring, transformation, and style replication workflow. Use when the user needs structured DOCX creation, existing document modification, style-preserving cloning, tracked-change handling, or technical validation of Word files.
tools: docx_create_markdown, docx_create_document, docx_init_task, docx_write_markdown, docx_write_xml, docx_pack_document, docx_unpack_document, docx_read_xml, docx_read_markdown, docx_extract_styles, docx_set_metadata, docx_find_replace, docx_insert_text, docx_merge_documents, docx_set_char_format, docx_set_para_format, docx_set_page_layout, docx_edit_table_cell, docx_insert_image, docx_set_header_footer, docx_insert_table, docx_accept_changes, docx_validate
---

# Document Word Skill

You are a Professional Word Document Engineer. You have a comprehensive suite of tools to analyze, create, and modify DOCX files.

## When To Use

- When the user wants to create a new document with specific styling.
- When the user wants to clone or replicate an existing document's look and feel.
- When the user wants to perform edits (find/replace, formatting) while preserving structure.
- When the user wants to validate a document's technical integrity.

## Workflow: Quick Document Creation (from Markdown)

If a user asks to create a simple document:

1. Call `docx_create_markdown(markdown="# Title\n\nContent...", output_path="output.docx")`.
2. Call `docx_validate(path="output.docx")`.

## Workflow: Structured Document Creation

If a user needs precise control over formatting:

1. Call `docx_create_document(output_path="output.docx", content=[...], font="...", page_size="a4", ...)`.
   - `content` is an array of blocks: `paragraph`, `table`, `image`, or `pageBreak`.
   - Each paragraph supports `runs` for mixed inline formatting (`bold`, `italic`, `color`, `fontSize`).
2. Call `docx_validate(path="output.docx")`.

## Workflow: Pipeline Creation (full control)

For complex documents requiring step-by-step processing:

1. `docx_init_task(session_id, task_id)` — initialize workspace.
2. `docx_write_markdown(task_dir, markdown)` — write markdown and parse to AST.
3. `docx_write_xml(task_dir)` — generate DOCX XML from AST.
4. `docx_pack_document(task_dir)` — pack into .docx archive.

## Workflow: Document Replication

If a user asks to recreate an existing document:

1. Extract styles.
   - Call `docx_extract_styles(path="original.docx")` to get style metadata (page layout, fonts, colors).
2. Read content.
   - Call `docx_unpack_document(task_dir, input_path="original.docx")`.
   - Call `docx_read_xml(task_dir)` to parse into AST.
   - Call `docx_read_markdown(task_dir)` to get readable content.
3. Recreate.
   - Call `docx_create_document(output_path="clone.docx", content=[...])` using extracted data.
4. Validate.
   - Call `docx_validate(path="clone.docx")`.

## Workflow: Editing an Existing Document

If a user asks to modify an existing document:

1. Read the document.
   - `docx_unpack_document` + `docx_read_xml` + `docx_read_markdown` to inspect content.
2. Apply edits.
   - `docx_find_replace(path, find, replace)` for text substitution.
   - `docx_set_char_format(path, ...)` for character formatting (bold, italic, color, font size).
   - `docx_set_para_format(path, ...)` for paragraph formatting (alignment, spacing, indent).
   - `docx_set_page_layout(path, ...)` for page dimensions and margins.
   - `docx_insert_text(path, text)` to append paragraphs.
   - `docx_insert_image(path, image_path, ...)` to add images.
   - `docx_insert_table(path, rows, cols, ...)` to add tables.
   - `docx_edit_table_cell(path, table_index, row, col, text)` to edit table cells.
   - `docx_set_header_footer(path, type, text)` to set headers/footers.
   - `docx_set_metadata(path, title, author, ...)` to update document metadata.
3. Handle tracked changes if present.
   - `docx_accept_changes(path)` to accept all tracked changes.
4. Validate.
   - `docx_validate(path)`.

## Workflow: Merging Documents

- `docx_merge_documents(input_paths=["a.docx", "b.docx"], output_path="merged.docx")`.

## Tool Selection Guide

- Use `docx_create_markdown` for rapid drafting from markdown text.
- Use `docx_create_document` when layout and style control must be explicit.
- Use `docx_unpack_document` + `docx_read_xml` + `docx_read_markdown` before heavy edits on existing files.
- Use `docx_validate` after every create/edit/merge operation.

## Tool Reference

### `docx_create_markdown(markdown, output_path)`

Create a DOCX from Markdown. Supports headings, bold, italic, lists, tables, code blocks, blockquotes.

### `docx_create_document(output_path, content, page_size, font, font_size,margin,header,footer,title)`

Create a structured DOCX from a content array.

- `content`: array of blocks, each with one of:
  - `paragraph`: `text`, `runs[]`, `heading` (1-6), `bold`, `italic`, `underline`, `color`, `fontSize`, `fontName`, `alignment` (`LEFT`/`CENTER`/`RIGHT`/`JUSTIFY`), `bullet`, `numbered`, `lineSpacing`, `indent`, `spacing`, `pageBreak`
  - `table`: `rows[][]`, `headerRow`, `headerBackground`, `columnWidths[]`
  - `image`: `path`, `width_mm`, `height_mm`
  - `pageBreak`: `true`
- `page_size`: `"a4"`, `"b5"`, or `"letter"`
- `margin`: `{ top, bottom, left, right }` in mm

### `docx_init_task(session_id, task_id, work_dir)`

Initialize a pipeline task workspace.

### `docx_write_markdown(task_dir, markdown)`

Save markdown content and parse into AST.

### `docx_write_xml(task_dir, page_width,page_height,margin_top,margin_bottom,margin_left,margin_right)`

Generate DOCX XML files from AST. Dimensions in mm.

### `docx_pack_document(task_dir)`

Pack intermediate folder into a .docx archive.

### `docx_unpack_document(task_dir, input_path)`

Unpack an existing .docx for inspection or modification.

### `docx_read_xml(task_dir)`

Parse DOCX XML into AST.

### `docx_read_markdown(task_dir)`

Convert AST to readable markdown.

### `docx_extract_styles(path)`

Extract style metadata as JSON (page layout, fonts, theme colors, named styles).

### `docx_set_metadata(path, title,author,subject,keywords,output_path)`

Update document metadata.

### `docx_find_replace(path, find, replace, output_path,case_sensitive)`

Find and replace text in a DOCX.

### `docx_insert_text(path, text, output_path)`

Append text paragraphs to a DOCX.

### `docx_merge_documents(input_paths, output_path)`

Merge multiple DOCX files into one.

### `docx_set_char_format(path, target_text,paragraph_index,bold,italic,underline, font_size,text_color, font_name,output_path)`

Apply character formatting to runs.

### `docx_set_para_format(path, target_text,paragraph_index,alignment,line_spacing,indent,margin_left,margin_right,space_before,space_after,output_path)`

Apply paragraph formatting.

### `docx_set_page_layout(path, page_width,page_height,margin_top,margin_bottom,margin_left,margin_right,margin_header,margin_footer,output_path)`

Set page dimensions and margins. All values in mm.

### `docx_edit_table_cell(path, row, col, table_index,text,background_color,bold,output_path)`

Edit a specific table cell.

### `docx_insert_image(path, image_path, width_mm,height_mm,output_path)`

Insert an image into a DOCX.

### `docx_set_header_footer(path, type, text, alignment,output_path)`

Set or replace header/footer. `type`: `"header"` or `"footer"`.

### `docx_insert_table(path, rows, cols, headers,data,output_path)`

Insert a table into a DOCX.

### `docx_accept_changes(path, output_path)`

Accept all tracked changes in the document.

### `docx_validate(path)`

Validate DOCX file structure and OOXML spec compliance.

## Rules

- Use `docx_create_markdown` for simple documents from markdown content.
- Use `docx_create_document` when precise formatting control is needed.
- Use the pipeline (`docx_init_task` -> `docx_write_markdown` -> `docx_write_xml` -> `docx_pack_document`) for complex multi-step creation.
- Always call `docx_validate` after creating or modifying a document.
- Page dimensions and margins are in mm. Font sizes are in pt unless stated otherwise.

## Quality Checks

- Verify output opens in Word-compatible viewers without repair prompts.
- Confirm heading levels, table structure, and image sizing after bulk edits.
- For replication tasks, compare style profile fields (page size, margins, fonts, alignments).
- For tracked-change workflows, confirm whether changes should remain tracked or be accepted.

## Output Contract

Return:

- final `output_path`
- ordered summary of tool calls
- what changed (content, formatting, structure, metadata)
- validation status and any remaining risks
