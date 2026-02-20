---
name: local_search_task
description: Local file search and content exploration workflow
server_tools:
client_tools: find, grep, read, ls
depends_on:
---
You have `find`, `grep`, `read` and `ls` tools for local file search.

## Search procedure

Step 1: Verify path.
  Call `ls()` to confirm cwd contents.
  IF user mentioned a specific path → call `ls(path="<that path>")` to verify it exists.
  IF path error → ask the user to confirm the correct path. Do NOT guess.

Step 2: Choose search strategy.
  IF file name or extension known → call `find(pattern="**/*.py")`
  ELIF code/text keyword known → call `grep(pattern="class Foo", glob="*.py")`
  ELSE → call `ls(path="src/")` to explore structure, then go back to step 2.

Step 3: Inspect results.
  IF matches found → call `read(path=<result>)` to inspect the file.
  IF 0 matches → go to Recovery.

## Recovery (when search returns 0 results)

Do NOT give up. Do NOT repeat the same query. Escalate through these levels:

Level 1: Try naming variations in parallel.
```
grep(pattern="UserService", glob="*.py")
grep(pattern="user_service", glob="*.py")
grep(pattern="userService", glob="*.py")
grep(pattern="user-service", glob="*.py")
```

Level 2: Drop glob filter + enable `ignore_case`.
```
grep(pattern="userservice", ignore_case=true)
```

Level 3: Shorten to core keyword + use regex.
```
grep(pattern="[Uu]ser.*[Ss]erv", glob="*.py")
grep(pattern="user", glob="*.py", limit=20)
```

Level 4: Stop guessing. Map the actual structure first.
```
ls(path="src/")
find(pattern="**/*.py", path="src/")
→ read a few candidate files to understand the layout
→ re-attempt grep with corrected path or naming
```

Level 5: Try alternative file extensions.
```
find(pattern="**/user*.*")
find(pattern="**/*.{ts,js,tsx,jsx}")
find(pattern="**/*.{py,pyx,pyi}")
```

IF all levels fail → tell the user what you tried and ask for guidance.

## Tool reference

`find(pattern, path?, limit?)`
  Find files by glob pattern. Use when you know part of the filename or extension.
  - `pattern`: glob string (required). e.g. `"*.py"`, `"**/*.ts"`, `"src/**/test_*.py"`
  - `path`: directory to search in (default: cwd)
  - `limit`: max results (default: 1000)

`grep(pattern, path?, glob?, ignore_case?, literal?, context?, limit?)`
  Search file contents. Use when looking for code, text, or definitions.
  - `pattern`: regex or literal string (required)
  - `path`: directory or file to search in (default: cwd)
  - `glob`: filter files, e.g. `"*.ts"`, `"**/*.spec.ts"`
  - `ignore_case`: case-insensitive search
  - `literal`: treat pattern as literal, not regex. Use for special chars like `"price >= 100.0"`
  - `context`: lines to show before/after each match. Avoids a separate read call.
  - `limit`: max matches (default: 100)

`read(path, offset?, limit?)`
  Read file contents. Use after locating a file with find or grep.
  - `path`: file path (required)
  - `offset`: start line, 1-indexed. Use for large files.
  - `limit`: max lines to read. Use with offset to paginate.

`ls(path?, limit?)`
  List directory contents. Use to explore structure or verify paths.
  - `path`: directory to list (default: cwd)
  - `limit`: max entries (default: 500)

## Usage examples

File name known → find → read:
```
find(pattern="**/config.*") → read(path="src/config.ts")
```

Code search → grep with context → read for detail:
```
grep(pattern="def authenticate", glob="*.py", context=3)
→ read(path="src/auth.py", offset=45, limit=30)
```

Structure exploration → ls → find → read:
```
ls(path="src/") → find(pattern="src/services/**/*.py") → read(path="src/services/user.py")
```

Class/function definition lookup:
```
grep(pattern="class UserService", glob="*.py")
→ read(path=<matched file>, offset=<line - 5>, limit=50)
```

Import/usage tracing:
```
grep(pattern="from.*auth.*import|require.*auth", glob="*.{py,ts}")
```

Scoped search with context:
```
grep(pattern="TODO|FIXME|HACK", path="src/", glob="*.py", ignore_case=true, context=2)
```

Exact string match (special chars):
```
grep(pattern="price >= 100.0", literal=true, glob="*.py")
```

Large file pagination:
```
read(path="data/large.csv", offset=1, limit=50)
→ read(path="data/large.csv", offset=51, limit=50)
```

Multi-extension file discovery:
```
find(pattern="**/*.{json,yaml,yml,toml}", path="config/")
```

Parallel search (multiple independent queries in one turn):
```
grep(pattern="class.*Controller", glob="*.py")   ← parallel
grep(pattern="class.*Service", glob="*.py")       ← parallel
find(pattern="**/test_*.py")                      ← parallel
```

## Rules
- DO prefer `find` over `grep` when a filename pattern is sufficient. It's faster.
- DO use grep's `glob` parameter to narrow scope. Never grep the entire codebase without a filter.
- DO use grep's `context` parameter to see surrounding lines without a separate read call.
- DO run multiple independent searches in parallel in a single turn.
- DO NOT use `bash` for search tasks. Use `find` and `grep` instead.
- DO NOT repeat a failed query. Change at least one parameter each attempt.
- DO NOT guess paths. Verify with `ls` first.
