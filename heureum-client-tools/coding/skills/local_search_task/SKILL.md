---
name: local_search_task
description: Local file search and content exploration workflow
tools: find, grep, read, ls
---

# Local Search Skill

You have `find`, `grep`, `read`, and `ls` tools for local file search.

## Search Procedure

1. Verify path.
   - Call `ls()` to confirm current working directory contents.
   - If the user mentions a specific path, call `ls(path="<that path>")` to verify it exists.
   - If there is a path error, ask the user to confirm the correct path. Do not guess.
2. Choose search strategy.
   - If file name or extension is known, call `find(pattern="**/*.py")`.
   - Else if a code or text keyword is known, call `grep(pattern="class Foo", glob="*.py")`.
   - Else call `ls(path="src/")` to explore structure, then return to this step.
3. Inspect results.
   - If matches are found, call `read(path=<result>)`.
   - If there are no matches, move to recovery.

## Recovery When Search Returns 0 Results

Do not give up. Do not repeat the same query. Escalate through these levels.

1. Try naming variations in parallel.

```text
grep(pattern="UserService", glob="*.py")
grep(pattern="user_service", glob="*.py")
grep(pattern="userService", glob="*.py")
grep(pattern="user-service", glob="*.py")
```

2. Drop glob filter and enable `ignoreCase`.

```text
grep(pattern="userservice", ignoreCase=true)
```

3. Shorten to core keyword and use regex.

```text
grep(pattern="[Uu]ser.*[Ss]erv", glob="*.py")
grep(pattern="user", glob="*.py", limit=20)
```

4. Stop guessing and map structure first.

```text
ls(path="src/")
find(pattern="**/*.py", path="src/")
-> read a few candidate files to understand layout
-> retry grep with corrected path or naming
```

5. Try alternative file extensions.

```text
find(pattern="**/user*.*")
find(pattern="**/*.{ts,js,tsx,jsx}")
find(pattern="**/*.{py,pyx,pyi}")
```

If all levels fail, tell the user what you tried and ask for guidance.

## Tool Reference

### `find(pattern, path?, limit?)`

Find files by glob pattern. Use when you know part of a filename or extension.

- `pattern`: glob string (required), for example `"*.py"`, `"**/*.ts"`, `"src/**/test_*.py"`
- `path`: directory to search in (default: current working directory)
- `limit`: max results (default: `1000`)

### `grep(pattern, path?, glob?, ignoreCase?, literal?, context?, limit?)`

Search file contents. Use when looking for code, text, or definitions.

- `pattern`: regex or literal string (required)
- `path`: directory or file to search in (default: current working directory)
- `glob`: file filter, for example `"*.ts"`, `"**/*.spec.ts"`
- `ignoreCase`: case-insensitive search
- `literal`: treat pattern as literal (useful for special chars like `"price >= 100.0"`)
- `context`: lines before or after each match
- `limit`: max matches (default: `100`)

### `read(path, offset?, limit?)`

Read file contents. Use after locating files with `find` or `grep`.

- `path`: file path (required)
- `offset`: start line (1-indexed)
- `limit`: max lines to read

### `ls(path?, limit?)`

List directory contents. Use to explore structure or verify paths.

- `path`: directory to list (default: current working directory)
- `limit`: max entries (default: `500`)

## Usage Examples

### File name known: `find` then `read`

```text
find(pattern="**/config.*")
read(path="src/config.ts")
```

### Code search: `grep` with context then `read`

```text
grep(pattern="def authenticate", glob="*.py", context=3)
read(path="src/auth.py", offset=45, limit=30)
```

### Structure exploration: `ls`, `find`, then `read`

```text
ls(path="src/")
find(pattern="src/services/**/*.py")
read(path="src/services/user.py")
```

### Class or function definition lookup

```text
grep(pattern="class UserService", glob="*.py")
read(path=<matched file>, offset=<line - 5>, limit=50)
```

### Import or usage tracing

```text
grep(pattern="from.*auth.*import|require.*auth", glob="*.{py,ts}")
```

### Scoped search with context

```text
grep(pattern="TODO|FIXME|HACK", path="src/", glob="*.py", ignoreCase=true, context=2)
```

### Exact string match with special chars

```text
grep(pattern="price >= 100.0", literal=true, glob="*.py")
```

### Large file pagination

```text
read(path="data/large.csv", offset=1, limit=50)
read(path="data/large.csv", offset=51, limit=50)
```

### Multi-extension file discovery

```text
find(pattern="**/*.{json,yaml,yml,toml}", path="config/")
```

### Parallel search in one turn

```text
grep(pattern="class.*Controller", glob="*.py")
grep(pattern="class.*Service", glob="*.py")
find(pattern="**/test_*.py")
```

## Folder Analysis Strategy

When asked to "analyze a folder" or "understand the codebase", **do not repeatedly call `ls`** to traverse every subdirectory one by one. This wastes tokens and time. Instead, use a top-down generalizable approach:

1. **Find entry points and metadata**: Locate and `read` structural files first (e.g., `README.md`, `package.json`, `pyproject.toml`, `docker-compose.yml`, `Makefile`). They usually explain the architecture.
2. **Blanket structural search**: Call `find(pattern="**/*.*", path="<target_dir>")` to get a flat list of the entire directory tree in a single turn. You can immediately see all subdirectories and files without needing to `ls` into them.
3. **Sample core files**: From the tree list, pick and `read` the main orchestrators (`main.ts`, `app.py`, `index.js`, or router files) to grasp how the logic flows.

## Rules

- Do prefer `find` over `grep` when a filename pattern is enough; it is faster.
- Do use `grep` `glob` to narrow scope. Do not grep the entire codebase without filtering.
- Do use `grep` `context` to inspect surrounding lines without extra `read` calls.
- Do run multiple independent searches in parallel in a single turn.
- Do exclude irrelevant directories like `node_modules/`, `.git/`, and `dist/` or `build/` to save search resources and time.
- Do not attempt to `read` or `grep` binary, minified (`*.min.js`), lockfiles (`*-lock.json`), or other machine-generated assets unless explicitly requested.
- Do refine your search if the results hit the exact `limit` boundary. A saturated result list usually means your query is too broad; narrow the scope before trying to read them all.
- Do not use `ls` repetitively to manually traverse deep directory trees. Build a bird's-eye view using a broad `find` instead.
- Do not use `bash` for search tasks. Use `find` and `grep` instead.
- Do not repeat a failed query. Change at least one parameter each attempt.
- Do not guess paths. Verify with `ls` first.
