# Dev → Main 아키텍처 마이그레이션 가이드

> **원칙**: main의 기존 기능(로그인, SSE, 알림, 파일, todo, 주기작업, 가격 등)을 유지하면서, dev의 아키텍처 개선사항을 반영한다.
> 분석 기준: 2026-02-17 / 이전 레포: `/Users/choihk/Desktop/workspace/heureum-agent` (dev 브랜치)

---

## 현황 요약

| | 현재 main (새 레포) | dev (이전 레포) |
|---|---|---|
| **tool_schema.py** | 있음 (20KB, 서버에서 스키마 관리) | **삭제됨** (클라이언트가 스키마 소유) |
| **도구 실행** | 서버 + 클라이언트 혼합 (서버 중심) | **Client-Owns-Schema** (클라이언트 중심) |
| **@heureum/* 패키지** | 없음 | 6개 패키지 (coding/pdf/ppt/web/word/xlsx) |
| **컴팩션** | 3-layer 있음 | 개선된 3-layer + 전용 프롬프트 |
| **에러 분류** | 인라인 처리 | 전용 `error.py` 서비스 |
| **프론트 도구 모듈** | api.ts에 인라인 | `src/lib/tools/` 모듈 분리 |
| **Tavily 검색** | 없음 | MCP 서버에 통합 |
| **Electron 도구** | 없음 (bash/browser/docx만) | `tools.ts` + @heureum/* 핸들러 통합 |

**main에만 있는 기능** (유지해야 함):
- 로그인/인증 (allauth), SSE 스트리밍, 알림, 파일시스템
- todo/주기작업 서비스, 가격/비용, 랜딩페이지, 인프라
- 딥링크, 파일 동기화, 자동 업데이트

**dev에만 있는 아키텍처** (반영해야 함):
- Client-Owns-Schema: 도구 스키마를 클라이언트가 요청 시 전달
- @heureum/* 모노레포 패키지 (word/pdf/ppt/xlsx/web/coding)
- 에이전트 라우터/서비스 리팩터링
- 전용 에러 분류 서비스, 컴팩션 프롬프트
- Tavily 웹 검색, 프론트엔드 도구 모듈화

---

## 전략: main 기반 위에 dev 아키텍처를 단계적으로 반영

이전 가이드와 **방향이 반대**. main의 기능을 깨뜨리지 않으면서 dev의 구조를 적용한다.

---

## Phase 1: 독립적 추가 (충돌 없음)

순수하게 새 디렉토리/파일을 추가하는 작업. 기존 코드 수정 없음.

### 1-1. @heureum/* 도구 패키지 복사

dev에서 `heureum-client-tools/` 디렉토리 전체 복사:

```
heureum-client-tools/
├── coding/    # bash, read, edit, write, grep, find, ls (7 tools)
├── pdf/       # pdf_fill_fields, pdf_extract_form_fields 등 (8 tools)
├── ppt/       # ppt_add_slide, ppt_clean, ppt_create_thumbnails (3 tools)
├── web/       # web_fetch (1 tool) + SSRF 보호, 캐싱
├── word/      # docx_read, docx_redline, docx_comment 등 (12 tools)
└── xlsx/      # xlsx_recalc (1 tool)
```

각 패키지 공통 구조:
- `src/index.ts` — 메인 엔트리 (exports + handler)
- `src/tool-schema.ts` — ToolDefinition[] (클라이언트 소유 스키마)
- `package.json` — `@heureum/*` 스코프, tsup 빌드

**처리**: 디렉토리 복사 후 빌드 확인
```bash
cp -r /path/to/old-repo/heureum-client-tools ./heureum-client-tools
cd heureum-client-tools/coding && pnpm install && pnpm build
# 각 패키지 반복
```

### 1-2. 에러 분류 서비스 추가

dev에서 `app/services/error.py` 복사:

```python
# app/services/error.py (신규)
class LLMErrorClassifier:
    is_context_overflow()   # "context_length_exceeded", "too many tokens" 등
    is_retryable()          # 5xx, 429, rate limit
    is_thought_signature()  # Gemini: "Thought signature is not valid"
```

**처리**: 파일 복사만 (기존 코드 수정 없음)

### 1-3. 컴팩션 프롬프트 추가

dev에서 `app/services/prompts/compaction.py` 복사:

```python
# app/services/prompts/compaction.py (신규)
COMPACTION_PREFIX = "[compaction] Previous conversation summary:"
COMPACTION_SYSTEM_PROMPT = "You are a context summarization assistant..."
COMPACTION_INITIAL_BODY   # XML 포맷 (goal, progress, decisions, next-steps)
COMPACTION_UPDATE_BODY    # 기존 요약 업데이트
```

**처리**: 파일 복사만

### 1-4. 프론트엔드 도구 모듈 추가

dev에서 `src/lib/tools/` 디렉토리 복사:

```
heureum-frontend/src/lib/tools/
├── core.ts    # ASK_QUESTION_TOOL (ToolDefinition, guide 포함)
└── index.ts   # re-export
```

**처리**: 디렉토리 복사만 (아직 api.ts에서 import 안 함)

### 1-5. Electron 도구 모듈 추가

dev에서 `heureum-client/src/main/tools.ts` 복사:

```typescript
// heureum-client/src/main/tools.ts (신규)
import { CODING_TOOLS } from '@heureum/coding'
import { DOCX_TOOLS } from '@heureum/word'
import { PDF_TOOLS } from '@heureum/pdf'
// ...

export function getTools(context?: { cwd?: string | null }): ToolDefinition[]
export function buildSelectCwdTool(cwd: string | null): ToolDefinition
```

**처리**: 파일 복사 + package.json에 @heureum/* 의존성 추가 (Phase 3에서 연결)

### 1-6. Tavily 웹 검색

dev에서 복사:

```
heureum-mcp/src/tools/web/tavily.py          # Tavily REST API 클라이언트
heureum-mcp/tests/test_tavily_search.py       # 테스트
```

MCP 설정 업데이트:
- `heureum-mcp/src/tools/web/__init__.py` — tavily import 추가
- `heureum-mcp/.env.example` — `TAVILY_API_KEY` 추가
- `heureum-mcp/src/config.py` — `TAVILY_API_KEY` 설정 추가

### 1-7. 모바일 도구 정의

dev에서 복사:
```
heureum-mobile/tools.ts   # 15개 모바일 도구 정의 (device, sensor, contacts 등)
```

---

## Phase 2: Agent 핵심 리팩터링 (Critical)

> 이 단계가 가장 중요하고 위험. main의 서버 도구 실행 모델을 dev의 Client-Owns-Schema로 전환.

### 2-1. 아키텍처 전환 개요

**현재 (main)**:
```
서버가 tool_schema.py에서 모든 도구 스키마를 관리
→ 서버가 도구를 직접 실행하거나 클라이언트에 위임
→ tool_schema.py에 bash, browser, mobile, file, todo, periodic_task, notify 모두 정의
```

**목표 (dev 방식)**:
```
클라이언트가 요청 시 tools[] 배열로 도구 스키마를 전달
→ 서버는 client tools + MCP tools + 서버 전용 tools를 합쳐 LLM에 바인딩
→ tool_schema.py 삭제, 스키마는 각 @heureum/* 패키지 + 서비스 내부에 분산
```

### 2-2. `tool_schema.py` 처리

**삭제 대상**: `heureum-agent/app/schemas/tool_schema.py` 전체

**이동할 스키마들**:

| 도구 | 이동 위치 | 이유 |
|------|----------|------|
| bash, read, edit, write, grep, find, ls | `@heureum/coding/src/tool-schema.ts` | 클라이언트 소유 |
| browser_* | `@heureum/coding` 또는 별도 패키지 | 클라이언트 소유 (Chrome 확장) |
| mobile_* | `heureum-mobile/tools.ts` | 모바일 클라이언트 소유 |
| ask_question | `heureum-frontend/src/lib/tools/core.ts` | 프론트엔드 소유 |
| manage_todo | `app/services/todo_service.py` 내부 `TOOL_SCHEMA` | 서버 전용 |
| manage_periodic_task | `app/services/periodic_task_service.py` 내부 `TOOL_SCHEMA` | 서버 전용 |
| notify_user | `app/services/notification_service.py` 내부 `TOOL_SCHEMA` | 서버 전용 |
| read/write/list/delete_file | `agent.py` 내부 또는 별도 file_service.py | 서버 전용 (Platform API) |
| docx_* | `@heureum/word/src/tool-schema.ts` | 클라이언트 소유 |
| pdf_* | `@heureum/pdf/src/tool-schema.ts` | 클라이언트 소유 |
| ppt_* | `@heureum/ppt/src/tool-schema.ts` | 클라이언트 소유 |
| xlsx_* | `@heureum/xlsx/src/tool-schema.ts` | 클라이언트 소유 |
| web_fetch | `@heureum/web/src/tool-schema.ts` | 클라이언트 소유 |

### 2-3. `config.py` 수정

현재 main의 `CLIENT_TOOLS` 상수 등을 dev 방식으로 변경:

```python
# 제거할 것:
# - CLIENT_TOOLS 딕셔너리 (서버가 도구 목록을 하드코딩하는 패턴)
# - TOOL_SCHEMA_MAP 참조

# 유지할 것 (서버 전용 도구 분류):
AGENT_TOOLS: set[str] = {"manage_todo", "manage_periodic_task", "notify_user"}
SESSION_FILE_TOOLS: set[str] = {"read_file", "write_file", "list_files", "delete_file"}

# dev에서 추가된 설정:
CONTEXT_WINDOW_HARD_MIN_TOKENS: int = 16_000
MAX_OVERFLOW_RETRIES: int = 3
TOOL_CACHE_TTL: int = 300  # MCP 도구 캐시 5분
```

### 2-4. `agent.py` 리팩터링 (Critical)

**현재 (main) 구조**:
- 서버가 tool_schema.py에서 스키마를 가져와 LLM에 바인딩
- 서버가 모든 도구를 직접 실행하거나 클라이언트에 RPC
- todo/periodic/notify/file 도구를 서버에서 직접 실행

**목표 (dev) 구조**:
```python
class _AgentLoopRunner:
    def _resolve_tools(request: ResponseRequest):
        # 1. request.tools에서 클라이언트 도구 스키마 추출
        client_tool_schemas = request.tools  # 클라이언트가 보낸 것
        client_tool_names = {t.function.name for t in request.tools}
        client_tool_prompts = [t.guide for t in request.tools if t.guide]

        # 2. 서버 전용 도구 스키마 추가
        server_schemas = [
            TodoService.TOOL_SCHEMA,
            PeriodicTaskService.TOOL_SCHEMA,
            NotificationService.TOOL_SCHEMA,
            *session_file_tool_schemas,
        ]

        # 3. MCP 도구 동적 탐색
        mcp_schemas = await mcp_client.discover_tools()

        # 4. 전체 합치기
        all_schemas = client_tool_schemas + server_schemas + mcp_schemas
        return tool_names, all_schemas, client_tool_names, client_tool_prompts

    def classify_tool_calls(tool_calls, client_tool_names):
        client_calls = [tc for tc in tool_calls if tc.name in client_tool_names]
        server_calls = [tc for tc in tool_calls if tc.name not in client_tool_names]
        return client_calls, server_calls

    async def _handle_tool_call_iteration():
        # LLM 응답에서 도구 호출 분류
        client_calls, server_calls = classify_tool_calls(tool_calls, client_tool_names)

        if client_calls:
            # 클라이언트에게 반환 (INCOMPLETE 상태)
            return ResponseObject(status=INCOMPLETE, output=all_tool_calls)

        # 서버 도구만 있으면 직접 실행
        for tc in server_calls:
            if tc.name in AGENT_TOOLS:
                result = await agent_service.execute(tc)  # todo/periodic/notify
            elif tc.name in SESSION_FILE_TOOLS:
                result = await execute_session_file_tool(tc)
            else:
                result = await mcp_client.call_tool(tc)  # MCP
```

**핵심 변경 사항**:
1. `_resolve_tools()` — 클라이언트 스키마를 request.tools에서 가져오도록 변경
2. `classify_tool_calls()` — client_tool_names 기반 분류
3. `_handle_tool_call_iteration()` — client call 시 INCOMPLETE 반환
4. `_LoopContext` 데이터클래스 도입 (상태 관리 캡슐화)
5. main의 서버 도구(todo/periodic/notify/file)는 server_calls 분기에서 유지

### 2-5. `agent_service.py` 리팩터링

**dev에서 변경된 부분**:

1. **에러 분류 외부화**: 인라인 에러 체크 → `LLMErrorClassifier` 사용
   ```python
   from app.services.error import LLMErrorClassifier
   # 기존: if "context_length" in str(e)
   # 변경: if LLMErrorClassifier.is_context_overflow(e)
   ```

2. **컴팩션 프롬프트 개선**: 하드코딩된 요약 프롬프트 → `prompts/compaction.py` 참조
   ```python
   from app.services.prompts.compaction import (
       COMPACTION_PREFIX, COMPACTION_SYSTEM_PROMPT,
       COMPACTION_INITIAL_BODY, COMPACTION_UPDATE_BODY,
   )
   ```

3. **메시지 변환 정리**: `_SessionMessageView` 클래스 도입
   - Internal: LangChain BaseMessage
   - External: app.models.Message
   - 변환 메서드 캡슐화

4. **프롬프트 빌드 변경**: 클라이언트 도구 가이드를 동적으로 주입
   ```python
   def _prepare_prompt_and_tools(client_tool_prompts):
       system_prompt = build_system_prompt(
           client_tool_prompts=client_tool_prompts,  # dev 추가
           instructions=request.instructions,
       )
   ```

5. **main의 스트리밍은 유지**:
   - `_call_llm_stream()` — 그대로 유지
   - `stream_messages_with_tools()` — 그대로 유지

### 2-6. `prompts/base.py` 수정

**dev 변경사항 적용**:

1. **도구 가이드를 클라이언트에서 받도록 변경**:
   ```python
   # 현재 (main): 하드코딩된 BASH_TOOL_PROMPT, BROWSER_TOOL_PROMPT 등
   # 변경 (dev): 클라이언트 도구 가이드는 request에서 동적으로 수신

   def build_system_prompt(
       client_tool_prompts: list[str] = None,  # dev 추가
       ...
   ):
       parts = [AGENT_IDENTITY_PROMPT]
       if client_tool_prompts:
           parts.extend(client_tool_prompts)  # 클라이언트가 보낸 가이드
       # 서버 전용 가이드는 유지
       parts.append(TODO_TOOL_PROMPT)
       parts.append(PERIODIC_TASK_TOOL_PROMPT)
       parts.append(SESSION_FILE_TOOL_PROMPT)
       ...
   ```

2. **제거할 프롬프트**: `BASH_TOOL_PROMPT`, `BROWSER_TOOL_PROMPT`, `MOBILE_TOOL_PROMPT`
   (이제 @heureum/* 패키지의 tool-schema.ts에 guide 필드로 포함)

3. **유지할 프롬프트**: `TODO_TOOL_PROMPT`, `PERIODIC_TASK_TOOL_PROMPT`, `SESSION_FILE_TOOL_PROMPT`, `AGENT_IDENTITY_PROMPT`
   (서버 전용 도구 가이드)

### 2-7. 서비스 파일에 TOOL_SCHEMA 추가

main에 이미 있는 서비스 파일에 스키마를 내장:

```python
# app/services/todo_service.py — 기존 코드에 추가
class TodoService:
    TOOL_SCHEMA = {
        "type": "function",
        "function": {
            "name": "manage_todo",
            "description": "...",
            "parameters": { ... }
        }
    }

# app/services/periodic_task_service.py — 기존 코드에 추가
class PeriodicTaskService:
    TOOL_SCHEMA = { ... }

# app/services/notification_service.py — 기존 코드에 추가
class NotificationService:
    TOOL_SCHEMA = { ... }
```

### 2-8. `open_responses.py` 스키마 확장

dev에서 추가된 필드:

```python
class ToolDefinition(BaseModel):
    type: Literal["function"] = "function"
    function: FunctionDefinition
    guide: Optional[str] = None  # 신규: 시스템 프롬프트용 가이드 텍스트
```

`guide` 필드는 LLM 스키마에는 포함되지 않고, `build_system_prompt()`에서 텍스트로 주입됨.

### 2-9. 테스트 업데이트

dev에서 변경된 테스트들:
- `test_agent_service.py` — 에러 분류기 목킹, 새 컴팩션 로직
- `test_compaction.py` — 전용 프롬프트 사용
- `test_mcp_client.py` — classify_tool_calls 테스트
- `test_router_endpoint.py` — Client-Owns-Schema 기반 요청/응답
- `test_prompts.py` — 동적 프롬프트 빌드 테스트
- `test_router_helpers.py` — 삭제 (router에 통합)

---

## Phase 3: Electron 클라이언트 통합

### 3-1. `heureum-client/package.json` — @heureum/* 의존성 추가

```json
{
  "dependencies": {
    "@heureum/coding": "file:../heureum-client-tools/coding",
    "@heureum/word": "file:../heureum-client-tools/word",
    "@heureum/pdf": "file:../heureum-client-tools/pdf",
    "@heureum/ppt": "file:../heureum-client-tools/ppt",
    "@heureum/xlsx": "file:../heureum-client-tools/xlsx",
    "@heureum/web": "file:../heureum-client-tools/web"
  }
}
```

### 3-2. `heureum-client/src/main/index.ts` 수정

main의 기존 기능(딥링크, SSE 알림, 파일 동기화, 자동 업데이트)을 **유지**하면서:

**추가할 것 (dev)**:
1. `tools.ts` import 및 `get-tools` IPC 핸들러
2. `execute-tool` 통합 IPC 핸들러 (도구별 라우팅)
3. @heureum/* 패키지별 핸들러 매핑:
   ```typescript
   const TOOL_HANDLERS = {
     // @heureum/coding
     'bash': handleCodingTool,
     'read': handleCodingTool,
     'edit': handleCodingTool,
     'write': handleCodingTool,
     'grep': handleCodingTool,
     'find': handleCodingTool,
     'ls': handleCodingTool,
     // @heureum/word
     'docx_*': handleDocxTool,
     // @heureum/pdf
     'pdf_*': handlePdfTool,
     // @heureum/ppt
     'ppt_*': handlePptTool,
     // @heureum/xlsx
     'xlsx_*': handleXlsxTool,
     // @heureum/web
     'web_*': handleWebTool,
   }
   ```
4. Working directory 유효성 검사 (`validatePathsInWorkingDir()`)

**유지할 것 (main)**:
- `startNotificationStream()`, `syncSessionFiles()`, `startFileWatcher()`
- 딥링크 핸들러 (`heureum://auth/callback`)
- 자동 업데이트 (electron-updater)
- 기존 IPC 핸들러 (execute-bash, select-cwd, browser-command 등)

### 3-3. `heureum-client/src/preload/index.ts` 수정

**추가할 것 (dev)**:
```typescript
getTools: (context?) => ipcRenderer.invoke('get-tools', context),
executeTool: (name, args) => ipcRenderer.invoke('execute-tool', name, args),
canExecuteTools: true,  // 프론트엔드에서 클라이언트 도구 실행 가능 여부 확인용
```

**유지할 것 (main)**:
- 알림 관련 API (startNotificationStream, stopNotificationStream 등)
- 파일 관련 API (openSessionFolder, syncSessionFiles 등)
- 기존 API (executeBash, selectCwd, browserCommand 등)

---

## Phase 4: Frontend 통합

### 4-1. `heureum-frontend/src/lib/api.ts` 수정

**핵심 변경**: 도구 빌드/실행 파이프라인을 dev 방식으로 전환

**추가할 것 (dev)**:

1. **`buildTools()` 함수**: Electron/Mobile 도구 동적 수집
   ```typescript
   async function buildTools(): Promise<ToolDefinition[]> {
     const tools = [ASK_QUESTION_TOOL]  // from ./tools/core

     if (window.api?.canExecuteTools) {
       const electronTools = await window.api.getTools({ cwd: sessionCwd })
       tools.push(...electronTools)
     }

     // 모바일 도구 (선택적)
     if (isMobileApp()) {
       tools.push(...getMobileTools())
     }

     return tools
   }
   ```

2. **도구 호출 분류 로직**:
   ```typescript
   // Interactive (순차): ask_question, select_cwd
   // Permission Required (배치): 클라이언트 도구 중 승인 필요
   // Parallelizable (병렬): 서버/MCP + 승인된 클라이언트 도구
   ```

3. **`sendMessage()` 파이프라인 변경**:
   ```typescript
   // 현재: 서버에 메시지 전송 → 서버가 도구 실행 → 결과 반환
   // 변경: 서버에 메시지 + tools[] 전송 → 서버가 INCOMPLETE 반환
   //   → 클라이언트가 도구 실행 → 결과와 함께 재전송 → 반복
   ```

**유지할 것 (main)**:
- CSRF 토큰 핸들링, `withCredentials: true`
- SSE 스트리밍 (`sendMessageStream`)
- 파일 API (`fetchSessionFiles`, `uploadSessionFile` 등)
- 알림 API (`notificationAPI`)
- 주기적 작업 API (`periodicTaskAPI`)
- 권한 시스템 (`/api/v1/permissions/`)

### 4-2. `heureum-frontend/src/types/electron.d.ts` 수정

**추가할 것 (dev)**:
```typescript
interface ElectronAPI {
  // 기존 유지 + 추가:
  getTools(context?: { cwd?: string | null }): Promise<ToolDefinitionShape[]>
  executeTool(name: string, args: Record<string, unknown>): Promise<ToolExecutionResult>
  canExecuteTools: boolean
}
```

### 4-3. `heureum-frontend/src/types/index.ts` 수정

**추가할 것 (dev)**:
- `ToolDefinition`에 `guide?: string` 필드
- `ToolExecutionResult` 타입
- `ToolCallInfo` 확장 (display 관련)

---

## Phase 5: Platform 연결

### 5-1. `heureum-platform/proxy/views.py`

**추가할 것 (dev)**:
```python
@api_view(["POST"])
def proxy_tool_execute(request: Request) -> Response:
    """서버 측 도구 실행 프록시 (MCP 도구용)"""
    # POST /api/v1/agent/tools/execute → Agent 서비스로 포워딩
```

**유지할 것 (main)**:
- 기존 `proxy_to_agent` (Open Responses 프록시)
- SSE 스트리밍 프록시
- 비용 계산 로직
- 세션/메시지 저장

### 5-2. `heureum-platform/heureum_platform/urls.py`

**추가할 것 (dev)**:
```python
path("api/v1/agent/tools/execute", proxy_tool_execute, name="proxy_tool_execute"),
```

---

## 파일별 변경 요약

### 새 파일 (dev에서 복사)

| 파일/디렉토리 | 내용 |
|-------------|------|
| `heureum-client-tools/` 전체 | @heureum/* 6개 패키지 |
| `heureum-agent/app/services/error.py` | LLM 에러 분류 서비스 |
| `heureum-agent/app/services/prompts/compaction.py` | 컴팩션 전용 프롬프트 |
| `heureum-frontend/src/lib/tools/core.ts` | ASK_QUESTION_TOOL 정의 |
| `heureum-frontend/src/lib/tools/index.ts` | re-export |
| `heureum-client/src/main/tools.ts` | Electron 도구 집계 |
| `heureum-mcp/src/tools/web/tavily.py` | Tavily 웹 검색 |
| `heureum-mcp/tests/test_tavily_search.py` | Tavily 테스트 |
| `heureum-mobile/tools.ts` | 모바일 도구 정의 |

### 삭제 파일

| 파일 | 이유 |
|------|------|
| `heureum-agent/app/schemas/tool_schema.py` | Client-Owns-Schema로 전환, 스키마 분산 |

### 수정 파일 (심각도 순)

| 파일 | 심각도 | 변경 내용 |
|------|--------|---------|
| `agent/app/routers/agent.py` | **Critical** | _resolve_tools 클라이언트 스키마 수용, classify_tool_calls, INCOMPLETE 반환 흐름, _LoopContext 도입 |
| `agent/app/services/agent_service.py` | **High** | 에러분류 외부화, 컴팩션 프롬프트 참조, 메시지 변환 정리, 프롬프트 빌드 시 client_tool_prompts 주입 |
| `frontend/src/lib/api.ts` | **High** | buildTools() 추가, sendMessage 파이프라인을 INCOMPLETE 루프로 변경, 도구 분류/실행 로직 |
| `client/src/main/index.ts` | **High** | get-tools/execute-tool IPC 추가, @heureum/* 핸들러 라우팅, 경로 유효성 검사 |
| `agent/app/services/prompts/base.py` | **Medium** | 클라이언트 도구 가이드 동적 주입, bash/browser/mobile 가이드 제거 |
| `agent/app/config.py` | **Medium** | CLIENT_TOOLS 제거, AGENT_TOOLS/SESSION_FILE_TOOLS 추가 |
| `agent/app/schemas/open_responses.py` | **Low** | ToolDefinition.guide 필드 추가 |
| `client/src/preload/index.ts` | **Low** | getTools, executeTool, canExecuteTools 추가 |
| `client/package.json` | **Low** | @heureum/* 의존성 추가 |
| `frontend/src/types/electron.d.ts` | **Low** | ElectronAPI 타입 확장 |
| `frontend/src/types/index.ts` | **Low** | guide 필드, ToolExecutionResult 타입 |
| `platform/proxy/views.py` | **Low** | proxy_tool_execute 엔드포인트 추가 |
| `platform/urls.py` | **Low** | tools/execute URL 추가 |
| `mcp/.env.example`, `mcp/src/config.py` | **Low** | TAVILY_API_KEY |
| `mcp/src/tools/web/__init__.py` | **Low** | tavily import |
| 서비스 파일들 (todo, periodic, notification) | **Low** | TOOL_SCHEMA 클래스 상수 추가 |

---

## 실행 순서

```
Phase 1 — 독립적 추가 (충돌 없음, 병렬 가능)
  ├── heureum-client-tools/ 전체 복사 + 빌드
  ├── app/services/error.py 복사
  ├── app/services/prompts/compaction.py 복사
  ├── frontend/src/lib/tools/ 복사
  ├── client/src/main/tools.ts 복사
  ├── mcp Tavily 파일 복사
  └── mobile/tools.ts 복사

Phase 2 — Agent 핵심 리팩터링 (순차, 테스트 동반)
  ├── 2-8. open_responses.py에 guide 필드 추가
  ├── 2-7. 서비스 파일에 TOOL_SCHEMA 추가
  ├── 2-3. config.py 수정
  ├── 2-6. prompts/base.py 수정
  ├── 2-5. agent_service.py 리팩터링
  ├── 2-4. agent.py 리팩터링 ★ 가장 위험
  ├── 2-2. tool_schema.py 삭제
  └── 2-9. 테스트 업데이트 + 실행

Phase 3 — Electron 클라이언트
  ├── package.json @heureum/* 의존성 + pnpm install
  ├── main/index.ts 도구 핸들러 통합
  └── preload/index.ts 새 API 추가

Phase 4 — Frontend
  ├── types 수정 (electron.d.ts, index.ts)
  └── api.ts 파이프라인 전환 ★ 두 번째로 위험

Phase 5 — Platform
  ├── proxy/views.py tool_execute 엔드포인트
  ├── urls.py 라우트 추가
  └── mcp 설정 업데이트

통합 테스트
  ├── 클라이언트 도구 실행 (coding, docx 등)
  ├── 서버 도구 실행 (todo, periodic, notify)
  ├── MCP 도구 실행 (web_search via Tavily)
  ├── 승인 워크플로 (ask_question)
  └── 기존 기능 회귀 (로그인, SSE, 알림, 파일)
```

---

## 위험 요소 & 완화 방안

| 위험 | 영향 | 완화 |
|------|------|------|
| agent.py 리팩터링 시 기존 서버 도구 깨짐 | todo/periodic/notify/file 작동 불가 | 서버 도구 분기를 먼저 구현하고 기존 테스트 통과 확인 |
| api.ts 파이프라인 전환 시 기존 기능 깨짐 | SSE, 파일, 알림 등 | 기존 API 함수들은 그대로 두고 sendMessage만 변경 |
| @heureum/* 빌드 실패 | 도구 실행 불가 | Phase 1에서 각 패키지 독립 빌드 확인 |
| tool_schema.py 삭제 시 참조 누락 | import 에러 | 삭제 전 grep으로 모든 참조 확인 후 대체 |
| Electron IPC 호환성 | 도구 실행 실패 | canExecuteTools 플래그로 점진적 전환 |
