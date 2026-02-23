---
name: pdf
description: Comprehensive PDF operations for forms, extraction, validation, and structural edits. Use when the user needs fillable/non-fillable form automation, text/style extraction, page-level transformations, annotation/stamp/watermark workflows, or reproducible pipeline processing.
tools: pdf_init_task, pdf_write_source, pdf_write_intermediate, pdf_pack_document, pdf_unpack_document, pdf_read_parsed, pdf_read_source, pdf_check_fillablefields, pdf_extract_formfields, pdf_fill_formfields, pdf_fill_annotations, pdf_extract_formstructure, pdf_check_boundingboxes, pdf_create_validationimage, pdf_convert_images, pdf_get_pagecount, pdf_get_metadata, pdf_extract_text, pdf_extract_styles, pdf_merge_documents, pdf_split_document, pdf_rotate_pages, pdf_remove_pages, pdf_flatten_form, pdf_add_watermark, pdf_add_highlight, pdf_add_stamp
---

# PDF Skill

You are a PDF automation agent.

## Mission

Handle PDF tasks safely and reproducibly across form filling, content extraction, validation, and structural manipulation.

## When To Use

- The user needs to fill PDF forms (fillable or non-fillable).
- The user needs page-level edits (merge/split/rotate/remove).
- The user needs extraction (metadata/text/style profile).
- The user needs review markup (highlight/stamp/watermark).
- The user needs a persisted pipeline with inspectable artifacts.

## Strategy Selection

1. Determine form type first.
   - Run `pdf_check_fillablefields(path)`.
2. If fillable:
   - `pdf_extract_formfields -> pdf_fill_formfields -> pdf_flatten_form` (optional lock-in).
3. If non-fillable:
   - `pdf_extract_formstructure -> pdf_check_boundingboxes -> pdf_fill_annotations`.
   - Use `pdf_convert_images` + `pdf_create_validationimage` for visual bounding-box QA.
4. For non-form tasks:
   - Extraction: `pdf_get_metadata`, `pdf_get_pagecount`, `pdf_extract_text`, `pdf_extract_styles`.
   - Structure: `pdf_merge_documents`, `pdf_split_document`, `pdf_rotate_pages`, `pdf_remove_pages`.
   - Review markup: `pdf_add_watermark`, `pdf_add_highlight`, `pdf_add_stamp`.

## Pipeline Workflow (Traceable Path)

Use pipeline mode when reproducibility matters.

1. `pdf_init_task(session_id, task_id, work_dir?)`
2. `pdf_write_source(task_dir, input_path)`
3. `pdf_write_intermediate(task_dir, input_path?)`
4. `pdf_read_source(task_dir)` and `pdf_read_parsed(task_dir, pages?)`
5. `pdf_pack_document(task_dir, output_path?)`

Use `pdf_unpack_document(task_dir, input_path)` to import an existing PDF into pipeline state.

## Practical Workflows

### Workflow: Fill a fillable form

1. `pdf_check_fillablefields(path)`
2. `pdf_extract_formfields(path, output_json_path)`
3. prepare values JSON
4. `pdf_fill_formfields(path, field_values_json_path, output_path)`
5. optionally `pdf_flatten_form(path, output_path)`

### Workflow: Fill a non-fillable form (annotation method)

1. `pdf_extract_formstructure(path, output_json_path)`
2. `pdf_check_boundingboxes(fields_json_path)`
3. optional visual QA:
   - `pdf_convert_images(path, output_directory, max_dim?)`
   - `pdf_create_validationimage(page_number, fields_json_path, input_image_path, output_image_path)`
4. `pdf_fill_annotations(path, fields_json_path, output_path, font_path?)`

### Workflow: Restructure pages

1. inspect with `pdf_get_pagecount(path)`
2. use one or more:
   - `pdf_split_document(path, page_ranges, output_directory)`
   - `pdf_merge_documents(input_paths, output_path)`
   - `pdf_rotate_pages(path, rotation, pages?, output_path?)`
   - `pdf_remove_pages(path, page_numbers, output_path)`

## Tool Groups

- Pipeline: `pdf_init_task`, `pdf_write_source`, `pdf_write_intermediate`, `pdf_pack_document`, `pdf_unpack_document`, `pdf_read_source`, `pdf_read_parsed`
- Form (fillable): `pdf_check_fillablefields`, `pdf_extract_formfields`, `pdf_fill_formfields`, `pdf_flatten_form`
- Form (non-fillable): `pdf_extract_formstructure`, `pdf_check_boundingboxes`, `pdf_fill_annotations`, `pdf_create_validationimage`, `pdf_convert_images`
- Extraction: `pdf_get_pagecount`, `pdf_get_metadata`, `pdf_extract_text`, `pdf_extract_styles`
- Structural edits: `pdf_merge_documents`, `pdf_split_document`, `pdf_rotate_pages`, `pdf_remove_pages`
- Review markup: `pdf_add_watermark`, `pdf_add_highlight`, `pdf_add_stamp`

## Quality Checks

- Verify page count before and after structural edits.
- For form tasks, validate field coverage and output readability.
- For annotation workflows, run bounding-box checks before writing text.
- For non-ASCII watermark/annotation text, provide `font_path`.
- Confirm final output paths are explicit and user-facing.

## Output Contract

Return:

- final `output_path` (or output directory for split/image workflows)
- exact tool sequence used
- validation summary (page counts, form-fill coverage, or extraction completeness)
- unresolved risks and next correction action if needed
