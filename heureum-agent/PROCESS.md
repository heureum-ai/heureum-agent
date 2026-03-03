# heureum-agent 핵심 프로세스

---

## 1. 에이전트 & 서비스 객체 생성

서버 시작 시 `app/routers/agent.py:52-57`에서 **모듈 레벨 싱글톤**으로 전부 생성됩니다.

```python
# app/routers/agent.py:52-57
chain_registry = ToolChainRegistry()                # 도구 체이닝 규칙
mcp_client     = MCPClient(chain_registry=chain_registry)  # MCP 서버 연결
agent_service  = AgentService()                     # ★ 핵심 에이전트 (LLM 포함)
todo_service   = TodoService()                      # ★ TODO 관리
periodic_task_service = PeriodicTaskService()        # 주기 작업
notification_service  = NotificationService()       # 푸시 알림
```

`AgentService()` 내부에서 LLM이 생성됩니다:

```python
# app/services/agent_service.py:330-349
class AgentService:
    def __init__(self):
        self._lc_sessions = {}           # 세션 저장소
        self._session_locks = {}         # 세션별 Lock
        self._session_last_access = {}   # TTL 관리
        self.compaction_settings = CompactionSettings()
        self.llm = create_llm()          # ★ LLM 인스턴스

# app/services/agent_service.py:133-171
def create_llm():
    model = settings.AGENT_MODEL  # 기본값: "gemini-3-flash-preview"
    if model.startswith("gemini"):
        if settings.GOOGLE_API_KEY:
            return ChatGoogleGenerativeAI(model=model, ...)   # Google AI Studio
        return ChatGoogleGenerativeAI(model=model, vertexai=True, ...)  # Vertex AI
    else:
        return ChatOpenAI(model=model, ...)  # OpenAI
```

MCP 도구는 **첫 요청 시 lazy 초기화**:

```python
# app/routers/agent.py:110-131
async def _ensure_initialized():
    mcp_tools = await mcp_client.discover_tools()
    agent_service.mcp_tools = mcp_tools   # AgentService에 도구 스키마 주입
```

---

## 2. 요청별 동적 컨텍스트 조립

에이전트 인스턴스를 요청마다 새로 만드는 것이 아니라, **싱글톤 AgentService가 요청마다 다른 컨텍스트를 조립**해서 같은 LLM에 넘기는 구조입니다.

```
AgentService (싱글톤 1개)                     [agent.py:54]
  │
  ├── llm = create_llm()                     ← LLM 인스턴스 1개 공유
  │
  ├── _lc_sessions (dict, 최대 1000개)        ← 세션별 대화 히스토리
  │     ["session-A"] = [msg1, msg2, ...]
  │     ["session-B"] = [msg1, msg2, ...]
  │
  └── _session_locks (dict)                   ← 세션별 동시접근 제어
        ["session-A"] = asyncio.Lock()
```

**요청이 들어올 때마다 조립되는 `_LoopContext`** (`agent.py:547-557`):

```python
@dataclass
class _LoopContext:
    request: ResponseRequest     # 이번 요청 원본
    session_id: str              # 세션 → 히스토리 연결 키
    messages: List[Message]      # 이번 요청의 입력 메시지
    tool_names: List[str]        # ★ 동적 병합된 도구 목록
    total_usage: Usage           # 토큰 사용량 추적
```

**도구 목록 동적 병합** (`agent.py:528-544`):

```python
def _resolve_tool_names(request):
    tool_names  = [클라이언트가 보낸 도구들]        # request.tools
                + [MCP 서버에서 발견된 도구들]      # mcp_client.server_tool_names
                + [SESSION_FILE_TOOLS]            # read_file, write_file, ...
                + [AGENT_TOOLS]                   # manage_todo, notify_user, ...
```

**세션 생명주기** (`agent_service.py:431-513`):

```
요청 도착 → _get_or_create_session(session_id)
             ├─ 인메모리 캐시 히트 → 즉시 반환
             ├─ 캐시 미스 → Platform DB에서 rehydrate 시도
             └─ rehydrate 실패 → 빈 세션 새로 생성
           _cleanup_stale_sessions()
             ├─ TTL(1시간) 초과 세션 제거
             └─ MAX_SESSIONS(1000) 초과 시 오래된 순 제거
```

---

## 3. 주요 실행 흐름

```
Client POST /api/v1/agent/responses
         │
         ▼
create_response()                                [agent.py:973]
  ├─ _ensure_initialized()        ← MCP 도구 최초 1회 탐색
  ├─ _extract_session_id()        ← metadata에서 세션ID
  ├─ _parse_input()               ← Request → Message 변환
  ├─ _resolve_tool_names()        ← Client + MCP + SessionFile + Agent 도구 병합
  ├─ _prepare_messages_for_session()
  └─ stream 여부 판단
       ├─ YES → StreamingResponse (SSE)
       └─ NO  → _AgentLoopRunner.run()
                    │
         ┌──────────▼──────────┐
         │  도구 없음?          │
         │  YES → Text-Only LLM│
         │  NO  ↓              │
         └──────────┬──────────┘
                    ▼
    ┌───────────────────────────────────┐
    │  for iteration in 1..50:         │
    │                                   │
    │  ★ TODO 분기점 1                   │
    │  _augmented_instructions()        │  ← 매 iteration마다 TODO 상태를
    │  → todo_service.get_state_prompt()│    시스템 프롬프트에 주입
    │                                   │
    │  process_messages_with_tools()    │
    │  → [System+TODO] + [History]     │
    │    + [New] → LLM 호출             │
    │                                   │
    │  ★ TODO 분기점 2                   │
    │  LLM 판단:                        │
    │    ├─ TEXT → 응답 반환 (루프 종료)   │
    │    └─ TOOL_CALL → 아래로 ↓        │
    │                                   │
    │  _handle_tool_call_iteration()    │
    │    ├─ classify (server/client)    │
    │    ├─ 승인 필요? → INCOMPLETE 반환  │
    │    ├─ 서버 도구 병렬 실행           │
    │    │                              │
    │    │  ★ TODO 분기점 3              │
    │    │  _execute_tool()             │
    │    │  name in AGENT_TOOLS?        │
    │    │  → todo_service.execute()    │
    │    │                              │
    │    ├─ 히스토리 저장                 │
    │    ├─ Chain Rule 확인 & 실행       │
    │    │                              │
    │    │  ★ TODO 추적점 4 (스트리밍)    │
    │    │  → SSE: response.todo.updated│
    │    │                              │
    │    ├─ Client Call → INCOMPLETE    │
    │    └─ 없으면 → messages=[]        │
    │       continue (다음 iteration)   │
    │                                   │
    │  50회 도달 → INCOMPLETE            │
    └───────────────────────────────────┘
```

---

## 4. TODO 분기점 상세

TODO는 코드가 강제 실행하는 것이 아니라, **매 iteration마다 LLM에게 현재 진행 상태를 알려주면 LLM이 자율적으로 다음 단계를 실행**하는 구조입니다.

### 분기점 1: 시스템 프롬프트에 TODO 상태 주입

```python
# app/routers/agent.py:608-614
def _augmented_instructions(self) -> str | None:
    base = self.ctx.request.instructions or ""
    todo_prompt = todo_service.get_state_prompt(self.ctx.session_id)
    if todo_prompt:
        return f"{base}\n\n{todo_prompt}" if base else todo_prompt
    return base or None
```

`get_state_prompt()`는 TODO 상태에 따라 LLM에게 **다음 행동을 지시**합니다:

```python
# app/services/todo_service.py:172-239 (핵심 분기 로직)
if failed_idx is not None:
    → "STOP: Step N has failed. Do NOT continue."
elif in_progress_idx is not None:
    → "ACTION REQUIRED: Execute step N now."
elif first_pending is not None:
    → "ACTION REQUIRED: Start next step."
else (전부 completed):
    → "All steps completed. Provide a final summary."
```

### 분기점 2: LLM이 manage_todo 호출 여부 결정

`agent_service.py:1330` — LLM이 `<current_todo>` 블록을 보고 manage_todo를 호출할지, 다른 도구를 호출할지, 텍스트를 반환할지 **자율 판단**.

### 분기점 3: 도구 디스패치에서 분기

```python
# app/routers/agent.py:183-204
async def _execute_tool(name, arguments, session_id):
    if name == "manage_periodic_task": → periodic_task_service
    if name == "notify_user":          → notification_service
    if name in AGENT_TOOLS:            → ★ todo_service.execute()
    if name in SESSION_FILE_TOOLS:     → Platform API (파일 CRUD)
    if mcp_client.is_server_tool(name):→ MCP 서버 호출
```

```python
# app/services/todo_service.py:52-78
async def execute(self, name, arguments, session_id):
    action = arguments.get("action", "")
    if action == "create":
        if ENABLE_WORKFLOW:  → ★ "@@WORKFLOW_SIGNAL@@{task}" 반환 (워크플로우 트리거)
        else:               → SessionTodo 생성 + TODO.md 저장 (레거시 순차 모드)
    if action == "update_step": → step.status/result 변경 + TODO.md 갱신
    if action == "add_steps":   → 기존 계획에 단계 추가
```

### 추적점 4: SSE 이벤트 발송 (스트리밍)

```python
# app/routers/agent.py:930-942
_todo_state = todo_service.get_state(self.ctx.session_id)
if _todo_state:
    yield SSE: {"type": "response.todo.updated",
                "todo": {"task": ..., "steps": [...]}}
```

### TODO 상태가 LLM에 도달하는 경로

```
_session_todos[session_id]         인메모리 저장소
         │
         ▼
get_state_prompt()                 <current_todo> XML 생성   [todo_service.py:172]
         │
         ▼
_augmented_instructions()          instructions에 합류       [agent.py:608]
         │
         ▼
_make_system_prompt(instructions)  프롬프트 끝 <instructions> [agent_service.py:766]
         │
         ▼
[SystemMessage] + [History] + [New Messages]  → LLM 호출
```

---

## 5. TODO 리스트 생성 흐름 (End-to-End)

LLM이 multi-step 작업이라고 판단하면 `manage_todo(action="create")`를 호출합니다.
`ENABLE_WORKFLOW` 설정에 따라 **두 가지 경로**로 분기됩니다.

```
LLM → manage_todo(action="create", task="...", steps=[...])
         │
         ▼
todo_service.create()                            [todo_service.py:94]
         │
    ┌────┴────────────────────────────────┐
    │ ENABLE_WORKFLOW?                     │
    ├─ YES → "@@WORKFLOW_SIGNAL@@{task}"   │  ← 시그널만 반환
    │         SessionTodo 생성 안 함        │
    └─ NO  → SessionTodo 생성 (레거시)     │  ← 기존 순차 모드
    └─────────────────────────────────────┘
         │                    │
    [워크플로우 경로]     [레거시 경로]
    → 섹션 8 참조          │
                           ▼
                  SessionTodo 객체 생성 (인메모리)
                  _write_todo_file() → TODO.md 저장
                  SSE: response.todo.updated → 프론트엔드
```

### TODO 데이터 구조 (변경됨)

```python
# todo_service.py:26-46
@dataclass
class TodoStep:
    description: str
    status: str = "pending"
    result: Optional[str] = None
    step_name: Optional[str] = None        # ★ 워크플로우 의존성 추적용 고유 ID
    depends_on: Optional[List[str]] = None  # ★ 의존하는 step_name 목록
    assigned_agent: Optional[str] = None    # ★ 할당된 에이전트 역할

@dataclass
class SessionTodo:
    task: str
    steps: List[TodoStep]
    filename: str = "TODO.md"
    is_workflow: bool = False               # ★ 워크플로우 모드 여부
```

---

## 6. TODO step 완료 처리 흐름 (레거시 순차 모드: `ENABLE_WORKFLOW=False`)

`ENABLE_WORKFLOW=False`일 때의 기존 동작입니다. LLM이 step을 하나씩 실행하고 완료 표시합니다. **코드가 자동으로 다음 step을 실행하는 것이 아니라, 매 iteration마다 LLM이 프롬프트를 보고 자율적으로 진행**합니다.

```
iteration N:
  get_state_prompt() → "ACTION REQUIRED: Start step 0"       [todo_service.py:227]
  LLM → manage_todo(action="update_step", step_index=0, status="in_progress")
  → update_step() → step[0].status = "in_progress"           [todo_service.py:111]
  → SSE: response.todo.updated (UI: step 0 = ✱ 진행중)

iteration N+1:
  get_state_prompt() → "ACTION REQUIRED: Execute step 0 now"  [todo_service.py:220]
  LLM → 실제 작업 도구 호출 (web_search, web_fetch 등)
  LLM → manage_todo(action="update_step", step_index=0, status="completed", result="...")
  → update_step() → step[0].status = "completed"
  → SSE: response.todo.updated (UI: step 0 = ✓ 완료)

iteration N+2:
  get_state_prompt() → "ACTION REQUIRED: Start step 1"
  ... (반복)

마지막 iteration:
  get_state_prompt() → "All steps completed. Provide a final summary."  [todo_service.py:232]
  LLM → 텍스트 응답 반환 (루프 종료)
```

**핵심: `update_step()` 메서드** (`todo_service.py:111-132`):
```python
async def update_step(self, session_id, step_index, status, result=None):
    step = todo.steps[step_index]
    step.status = status           # "in_progress" | "completed" | "failed"
    step.result = result           # "모델 경량화 연구 완료" 등
    await self._write_todo_file(session_id, todo)  # TODO.md 갱신
```

---

## 7. 전체 실행 흐름 (초기화 → 프롬프트 조립 → 루프 → 프롬프트 갱신)

```
┌─────────────────────────────────────────────────────┐
│  ■ 서버 시작 시 (1회) — 모듈 로드        agent.py:52-57     │
│                                                      │
│  chain_registry = ToolChainRegistry()                │
│  mcp_client     = MCPClient(...)                     │
│  agent_service  = AgentService()  ← llm = create_llm()      │
│  todo_service   = TodoService()                      │
│  periodic_task_service / notification_service         │
│                                                      │
│  ※ LLM 인스턴스 생성됨 (이후 불변, 전 세션 공유)       │
│  ※ MCP 도구는 아직 없음 (_initialized = False)        │
└──────────────────────┬──────────────────────────────┘
                       │
═══════════════════ 첫 번째 요청 도착 ═══════════════════
                       │
                       ▼
┌─────────────────────────────────────────────────────┐
│  ■ 1회성 MCP 초기화                      agent.py:110-130   │
│  _ensure_initialized()                               │
│    └─ mcp_tools = mcp_client.discover_tools()        │
│       agent_service.mcp_tools = mcp_tools            │
│       _initialized = True   ← 이후 요청은 스킵        │
└──────────────────────┬──────────────────────────────┘
                       │
═══════════════════ 매 요청마다 ═══════════════════════
                       │
                       ▼
┌─────────────────────────────────────────────────────┐
│  ■ 요청별 컨텍스트 조립                 agent.py:973-1040   │
│                                                      │
│  session_id = _extract_session_id(request)            │
│  messages   = _parse_input(request)                   │
│  tool_names = _resolve_tool_names(request)            │
│    ├─ 클라이언트 도구 (request.tools)                   │
│    ├─ MCP 서버 도구 (web_search, web_fetch, ...)      │
│    ├─ SESSION_FILE_TOOLS (read_file, write_file, ...) │
│    └─ AGENT_TOOLS (manage_todo, notify_user, ...)    │
│                                                      │
│  ctx = _LoopContext(request, session_id, messages,    │
│                     tool_names, ...)                  │
│  runner = _AgentLoopRunner(ctx)                       │
└──────────────────────┬──────────────────────────────┘
                       │
                       ▼
┌─────────────────────────────────────────────────────┐
│  ■ 세션 확보                    agent_service.py:431-530    │
│  _ensure_session(session_id)                         │
│    ├─ _cleanup_stale_sessions()                      │
│    │    ├─ TTL(1h) 초과 세션 제거                      │
│    │    └─ MAX(1000) 초과 시 오래된 순 제거             │
│    └─ _get_or_create_session(session_id)             │
│         ├─ 인메모리 히트 → 즉시 반환                    │
│         ├─ 캐시 미스 → Platform DB rehydrate          │
│         └─ 미스 → 빈 세션 생성                         │
└──────────────────────┬──────────────────────────────┘
                       │
═══════════════ 에이전트 루프 (최대 50회) ═══════════════
                       │
                       ▼
┌ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─┐
  for iteration in 1..50:              agent.py:616
│                                                      │
  ┌───────────────────────────────────────────────┐
│ │  ★ 프롬프트 조립 (매 iteration마다 재조립)        │   │
  │                                               │
│ │  instructions = _augmented_instructions()      │   │
  │    ├─ base = request.instructions (고정)       │
│ │    └─ todo_prompt = get_state_prompt()         │   │
  │         └─ <current_todo>                     │
│ │              0. [completed] 모델 경량화 연구     │   │
  │              1. [in_progress] 다양한 언어 탐색   │
│ │              ACTION REQUIRED: Execute step 1   │   │
  │            </current_todo>                     │
│ │                                               │   │
  │  system_prompt = build_system_prompt(tools)    │
│ │    ├─ AGENT_IDENTITY_PROMPT  (항상 동일)       │   │
  │    ├─ TODO_TOOL_PROMPT       (항상 동일)       │
│ │    └─ + <instructions>{todo_prompt}</...>      │   │
  │         └─ ★ 여기만 매 iteration 달라짐        │
│ │                                               │   │
  │  lc_messages = [                              │
│ │    SystemMessage(system_prompt),  ← 매번 새로   │   │
  │    ...history...,                 ← 누적       │
│ │    ...new_messages...             ← 이번 요청   │   │
  │  ]                                            │
│ └───────────────────────┬───────────────────────┘   │
                          │
│                         ▼                            │
  ┌───────────────────────────────────────────────┐
│ │  LLM 호출                   agent_service.py:829   │
  │  llm.bind_tools(tools).ainvoke(lc_messages)   │   │
│ └───────────────────────┬───────────────────────┘   │
                          │
│                    ┌────┴────┐                       │
                     │ 결과?   │
│                    └────┬────┘                       │
                ┌────────┴────────┐
│          TEXT 응답           TOOL_CALL                │
           → 루프 종료            │
│          → 응답 반환            ▼                     │
  ┌───────────────────────────────────────────────┐
│ │  도구 실행                      agent.py:664   │   │
  │                                               │
│ │  classify → server / client 분류               │   │
  │  승인 필요? → INCOMPLETE 반환 (루프 중단)       │
│ │                                               │   │
  │  _execute_tool_calls(server_calls)            │
│ │    ├─ manage_todo → todo_service.execute()     │   │
  │    │   ├─ create → SessionTodo 생성            │
│ │    │   └─ update_step → status 변경            │   │
  │    ├─ MCP 도구 → mcp_client.call_tool()       │
│ │    └─ session file → Platform API              │   │
  │                                               │
│ │  ★ NEW: _detect_workflow_signal(tool_results)  │   │
  │    └─ "@@WORKFLOW_SIGNAL@@" 감지?              │
│ │        ├─ YES → _run_workflow() (섹션 8)       │   │
  │        │         → 루프 탈출, 워크플로우 실행    │
│ │        └─ NO → 기존 루프 계속 ↓                │   │
  │                                               │
│ │  히스토리에 tool interaction 저장               │   │
  │  chain rule 확인 → 후속 도구 실행              │
│ │  SSE: response.todo.updated                    │   │
  │                                               │
│ │  client_calls → INCOMPLETE 반환                │   │
  │  없으면 → messages=[], continue               │
│ └───────────────────────┬───────────────────────┘   │
                          │
│                         ▼                            │
  ★ 다음 iteration → _augmented_instructions() 재호출
│   → get_state_prompt()에서 갱신된 TODO 상태 반영      │
    → 새 system prompt 조립 → LLM 호출
│                                                      │
└ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─┘

═══════════════════ 루프 종료 조건 ═══════════════════

  ├─ LLM이 TEXT 반환 → COMPLETED
  ├─ client tool call → INCOMPLETE (클라이언트 실행 후 재요청)
  ├─ 승인 필요 → INCOMPLETE (사용자 승인 후 재요청)
  └─ 50회 도달 → INCOMPLETE
```

### 불변 vs 가변 요소

| 구분 | 요소 | 변경 시점 |
|------|------|----------|
| **불변** | LLM 인스턴스 (`self.llm`) | 서버 생애주기 동안 1개 |
| **불변** | 시스템 프롬프트 템플릿 (`AGENT_IDENTITY_PROMPT` 등) | 코드 변경 시만 |
| **불변** | 도구 목록 (`tool_names`) | 세션 내 동일 |
| **가변** | `<current_todo>` 블록 | 매 iteration마다 `get_state_prompt()` 재생성 |
| **가변** | 대화 히스토리 | 도구 실행 결과가 누적 |
| **가변** | 세션 상태 | 요청마다 생성/복원/정리 |

---

## 8. 워크플로우 오케스트레이션 (`ENABLE_WORKFLOW=True`)

기존의 "1개 LLM이 step을 순차 실행"에서 → **"역할별 전문 에이전트를 동적 생성하고 병렬 실행"** 구조로 변경됩니다.

### 트리거 시점

```
에이전트 루프 중 도구 실행 후                    [agent.py:837]
  │
  _detect_workflow_signal(tool_results)          [agent.py:616]
  tool_result가 "@@WORKFLOW_SIGNAL@@" 로 시작?
  │
  ├─ YES → _run_workflow(task)                   [agent.py:632]
  │         └─ WorkflowRunner(llm, agent_service, execute_tool, todo_service, ...)
  │
  └─ NO → 기존 루프 계속
```

### 5단계 파이프라인

```
WorkflowRunner.run()                            [workflow_runner.py:77]
         │
  Phase 1: 역할 추출 ─────────────────────────────────────────
         │
         ▼
  RoleExtractor.extract(task, tool_names)        [role_extractor.py]
  → LLM에 ROLE_EXTRACTION_PROMPT 전달             [base.py:290]
  → AgentRoleExtraction 반환
       roles = [
         DynamicAgentRole(role_type="researcher", objective="...", tool_access=[...]),
         DynamicAgentRole(role_type="analyst",    objective="...", tool_access=[]),
       ]
         │
  Phase 2: 워크플로우 계획 ───────────────────────────────────
         │
         ▼
  WorkflowPlanner.plan(task, roles)              [workflow_planner.py]
  → LLM에 WORKFLOW_PLANNING_PROMPT 전달           [base.py:316]
  → WorkflowExecutionPlan 반환
       steps = [
         WorkflowStep(step_name="research_tesla", assigned_agent="researcher",
                      depends_on=[], task="Tesla 주가 조사"),
         WorkflowStep(step_name="research_apple", assigned_agent="researcher",
                      depends_on=[], task="Apple 주가 조사"),
         WorkflowStep(step_name="compare",        assigned_agent="analyst",
                      depends_on=["research_tesla", "research_apple"], ...),
       ]

  build_team_batches(steps)                      [workflow_planner.py]
  → Kahn's topological sort로 병렬 배치 생성
       batch 0: [research_tesla, research_apple]  ← 의존성 없음, 병렬 실행
       batch 1: [compare]                         ← batch 0 완료 후 실행
         │
  Phase 3: 오케스트레이션 TODO 생성 ──────────────────────────
         │
         ▼
  todo_service._create_orchestrated()            [todo_service.py:175]
  → SessionTodo(is_workflow=True) 생성
       steps = [
         TodoStep(description="[researcher] Tesla 주가 조사",
                  step_name="research_tesla", assigned_agent="researcher"),
         TodoStep(description="[researcher] Apple 주가 조사",
                  step_name="research_apple", assigned_agent="researcher"),
         TodoStep(description="[analyst] 비교 분석 작성",
                  step_name="compare", depends_on=["research_tesla","research_apple"],
                  assigned_agent="analyst"),
       ]
  → SSE: response.todo.updated → 프론트엔드에 TODO 표시
         │
  Phase 4: 배치별 병렬 실행 ──────────────────────────────────
         │
         ▼
  TeamExecutor.execute_all_batches(batches)      [team_executor.py]
         │
    batch 0: asyncio.gather(                     ← 병렬 실행
      _execute_step("research_tesla"),
      _execute_step("research_apple"),
    )
         │
    각 step 실행 = 미니 에이전트 루프:
      ┌─────────────────────────────────────────┐
      │ system_prompt = STEP_EXECUTION_PROMPT    │
      │   role_type: "researcher"                │
      │   objective: 역할 목표                    │
      │   step_task: "Tesla 주가 조사"            │
      │   context: 의존 step 결과 (있으면)         │
      │                                         │
      │ for i in 1..MAX_ORCHESTRATOR_STEP_ITERATIONS:
      │   LLM 호출 → TEXT / TOOL_CALL            │
      │   TOOL_CALL → _execute_tool() → 결과     │
      │   TEXT → step 완료                       │
      │                                         │
      │ todo update_step(status="completed")     │
      │ SSE: response.todo.updated               │
      └─────────────────────────────────────────┘
         │
    batch 1: asyncio.gather(                     ← batch 0 완료 후
      _execute_step("compare"),
        → context에 research_tesla, research_apple 결과 주입
    )
         │
  Phase 5: 결과 합성 ─────────────────────────────────────────
         │
         ▼
  Synthesizer.synthesize(user_message, step_results)  [synthesizer.py]
  → LLM에 SYNTHESIS_PROMPT + 모든 step 결과 전달       [base.py:350]
  → 최종 통합 응답 텍스트 반환
         │
         ▼
  TraceCollector.persist()                       [trace.py]
  → 실행 추적 마크다운 저장 (디버깅/관찰용)
         │
         ▼
  ResponseObject(status=COMPLETED, orchestration=True)
```

### 레거시 vs 워크플로우 비교

| 구분 | 레거시 (`ENABLE_WORKFLOW=False`) | 워크플로우 (`ENABLE_WORKFLOW=True`) |
|------|------|------|
| **에이전트 수** | 1개 LLM, 동일 프롬프트 | 역할별 전문 에이전트 (동적 생성) |
| **실행 방식** | 순차 (iteration마다 1 step) | 배치별 병렬 (`asyncio.gather`) |
| **프롬프트** | 고정 시스템 프롬프트 + `<current_todo>` | step마다 전용 `STEP_EXECUTION_PROMPT` |
| **step 진행** | LLM 자율 판단 (`update_step` 직접 호출) | `TeamExecutor`가 자동 관리 |
| **의존성** | 없음 (항상 순차) | `depends_on`으로 DAG 구성, 토폴로지 정렬 |
| **컨텍스트 전달** | 대화 히스토리에 누적 | 의존 step 결과를 context로 명시 주입 |
| **TODO 데이터** | `TodoStep(description, status)` | `+ step_name, depends_on, assigned_agent` |
| **결과** | LLM이 마지막에 요약 텍스트 반환 | `Synthesizer`가 전체 결과 합성 |

### 관련 설정 (`config.py`)

```python
ENABLE_WORKFLOW: bool = True              # 워크플로우 오케스트레이션 활성화
ORCHESTRATOR_MAX_ROLES: int = 5           # 최대 에이전트 역할 수
ORCHESTRATOR_MAX_STEPS: int = 10          # 최대 워크플로우 step 수
MAX_ORCHESTRATOR_STEP_ITERATIONS: int = 15  # step당 미니 루프 최대 반복
```

### 신규 파일 구조

```
app/services/orchestrator/
  ├── models.py            # DynamicAgentRole, WorkflowStep, StepResult 등
  ├── role_extractor.py    # Phase 1: LLM으로 역할 추출
  ├── workflow_planner.py  # Phase 2: 실행 계획 + 토폴로지 정렬
  ├── team_executor.py     # Phase 4: 배치별 병렬 실행 (미니 에이전트 루프)
  ├── synthesizer.py       # Phase 5: 결과 합성
  └── trace.py             # 실행 추적/관찰

app/routers/workflow_runner.py  # 5단계 파이프라인 통합 실행기
```

---

## 9. 핵심 지점 참조표

| 구분 | 파일:라인 | 역할 |
|------|----------|------|
| **에이전트 객체 생성** | `agent.py:54` | `agent_service = AgentService()` |
| **LLM 인스턴스 생성** | `agent_service.py:349` | `self.llm = create_llm()` |
| **LLM 팩토리** | `agent_service.py:133` | `create_llm()` — Gemini/OpenAI 분기 |
| **MCP Lazy 초기화** | `agent.py:110` | `_ensure_initialized()` |
| **TODO 서비스 생성** | `agent.py:55` | `todo_service = TodoService()` |
| **TODO 프롬프트 주입** | `agent.py:608` | `_augmented_instructions()` |
| **TODO 상태 생성** | `todo_service.py:172` | `get_state_prompt()` |
| **TODO 디스패치** | `agent.py:193` | `name in AGENT_TOOLS → todo_service.execute()` |
| **TODO action 분기** | `todo_service.py:52` | `create / update_step / add_steps` |
| **TODO SSE 이벤트** | `agent.py:930` | `response.todo.updated` |
| **TODO 데이터모델** | `todo_service.py:26` | `TodoStep`, `SessionTodo` |
| **TODO 생성 (create)** | `todo_service.py:87` | `create()` — SessionTodo 생성 + TODO.md 저장 |
| **TODO 도구 스키마** | `tool_schema.py:410` | `MANAGE_TODO_TOOL_SCHEMA` |
| **TODO SSE → 프론트** | `ChatPage.tsx:684` | `updateOrAddTodo(event.todo)` |
| **TODO 세션 정리** | `agent.py:97` | `todo_service.clear_session()` |
| **TODO step 완료** | `todo_service.py:111` | `update_step()` — status/result 변경 + TODO.md 갱신 |
| **동적 컨텍스트** | `agent.py:547` | `_LoopContext` — 요청마다 조립 |
| **도구 동적 병합** | `agent.py:528` | `_resolve_tool_names()` |
| **세션 생성/복원** | `agent_service.py:431` | `_get_or_create_session()` |
| **세션 정리** | `agent_service.py:485` | `_cleanup_stale_sessions()` |
| **엔드포인트** | `agent.py:973` | `create_response()` |
| **에이전트 루프** | `agent.py:616` | `_run_tool_iterations()` |
| **도구 호출 처리** | `agent.py:664` | `_handle_tool_call_iteration()` |
| **LLM 호출** | `agent_service.py:829` | `_call_llm()` |
| **오류 복구** | `agent_service.py:1029` | `_invoke_with_recovery()` |
| **워크플로우 설정** | `config.py:142` | `ENABLE_WORKFLOW`, `ORCHESTRATOR_MAX_ROLES` 등 |
| **워크플로우 시그널** | `todo_service.py:25` | `WORKFLOW_SIGNAL_PREFIX = "@@WORKFLOW_SIGNAL@@"` |
| **시그널 감지** | `agent.py:616` | `_detect_workflow_signal()` |
| **워크플로우 실행** | `agent.py:632` | `_run_workflow()` → `WorkflowRunner` |
| **파이프라인 통합** | `workflow_runner.py:45` | `WorkflowRunner.run()` / `stream_events()` |
| **역할 추출** | `role_extractor.py` | `RoleExtractor.extract()` — Phase 1 |
| **워크플로우 계획** | `workflow_planner.py` | `WorkflowPlanner.plan()` — Phase 2 |
| **토폴로지 정렬** | `workflow_planner.py` | `build_team_batches()` — Kahn's algorithm |
| **오케스트레이션 TODO** | `todo_service.py:175` | `_create_orchestrated()` — Phase 3 |
| **배치 병렬 실행** | `team_executor.py` | `TeamExecutor.execute_all_batches()` — Phase 4 |
| **결과 합성** | `synthesizer.py` | `Synthesizer.synthesize()` — Phase 5 |
| **실행 추적** | `trace.py` | `TraceCollector` — 파이프라인 관찰/디버깅 |

---

## 10. Orchestrator vs Sessions Spawn 비교 분석

### 개요

| 구분 | `app/services/orchestrator/` | `app/skills/sessions_spawn/` + `app/services/subagent.py` |
|------|------|------|
| 역할 | 계획 기반 멀티에이전트 파이프라인 | 에이전트 주도 즉석 병렬 실행 |
| 파일 수 | 7개 (models, role_extractor, workflow_planner, team_executor, synthesizer, trace, __init__) | 3개 (SKILL.md, service.py, subagent.py) |

### 실행 흐름 비교

**Orchestrator (5-Phase Pipeline)**

```
사용자 요청
  → RoleExtractor (LLM: 어떤 역할이 필요한지 결정)
  → WorkflowPlanner (LLM: 의존성 그래프 + 실행 계획 생성)
  → TeamExecutor (Kahn 알고리즘으로 배치 그룹핑 → 배치 단위 병렬 실행)
  → Synthesizer (LLM: 모든 스텝 결과를 종합하여 최종 응답 생성)
  → TraceCollector (실행 추적 기록 저장)
```

**Sessions Spawn (Ad-hoc Parallel)**

```
에이전트가 sessions_spawn 툴 호출
  → spawn_subagent() (자식 세션 생성)
  → _execute_subagent_task() (풀 AgentService 인스턴스로 독립 실행)
  → _announce_completion() (SystemMessage로 부모에 결과 전달)
  → 에이전트가 직접 결과 종합
```

### 상세 비교

| 항목 | Orchestrator | Sessions Spawn |
|------|-------------|----------------|
| **트리거** | 워크플로우 시그널 (시스템 자동) | LLM이 `sessions_spawn` 툴 호출 |
| **계획 단계** | LLM 역할 추출 + 의존성 그래프 설계 | 없음 (에이전트 판단) |
| **실행 방식** | `_run_mini_loop()` — 경량 루프 (직접 LangChain 호출) | `_execute_subagent_task()` — 풀 `AgentService` 인스턴스 |
| **병렬화** | Kahn 알고리즘 배치 그룹핑 (의존성 순서 보장) | 전부 동시 spawn (순서 없음) |
| **데이터 흐름** | 스텝 간 `_serialize_context()`로 결과 전달 | `SystemMessage`로 부모에 결과 전달 |
| **합성** | `Synthesizer` LLM 호출로 최종 응답 생성 | 없음 (에이전트가 직접 종합) |
| **트레이싱** | `TraceCollector` — 전체 파이프라인 상세 기록 | 기본 progress 추적만 |
| **격리 수준** | 미니루프 (AgentService 없이 LangChain 메시지만) | 풀 격리 (새 AgentService 인스턴스) |
| **깊이 제한** | 1단계 | 1단계 (`SUBAGENT_MAX_SPAWN_DEPTH`) |
| **동시 실행 제한** | `ORCHESTRATOR_MAX_ROLES` (기본 5) | `SUBAGENT_MAX_CHILDREN` (기본 5) |

### 핵심 겹치는 부분

둘 다 **"서브 에이전트에게 툴 접근을 주고 LLM 루프를 돌린다"** 는 동일한 핵심 동작을 수행하지만 실행 방식이 다름:

- **`TeamExecutor._run_mini_loop()`** — 경량. `self._llm.bind_tools(tools).ainvoke(lc_messages)` 직접 호출. AgentService 없이 LangChain 메시지 리스트만 관리
- **`_execute_subagent_task()`** — 풀 격리. 새 `AgentService` 인스턴스 생성, 세션 관리, 스킬 프로바이더 연결, 루프 디텍션 등 전체 기능 포함

### 병합 가능성

| 방향 | 장점 | 단점 |
|------|------|------|
| **Orchestrator가 `spawn_subagent()` 사용** | 실행 코드 통일, 각 스텝이 풀 AgentService 기능 사용 가능 | 오버헤드 증가, 의존성 기반 컨텍스트 전달이 복잡해짐, fire-and-forget vs 배치 동기 실행 불일치 |
| **Sessions Spawn이 미니루프 사용** | 경량화 | spawn은 풀 격리가 필요하므로 미니루프로는 부족 |
| **공통 SubAgentRunner 추출** | 가장 깔끔한 통합, 모드 선택(경량/풀) 가능 | 추상화 복잡도 증가 |

### 결론

두 모듈은 **다른 실행 패턴**을 위한 것:

- **Orchestrator** = 계획된 구조적 파이프라인 (의존성 그래프, 배치 실행, 합성)
- **Sessions Spawn** = 즉석 에이전트 주도 병렬화 (독립 태스크, fire-and-forget)

단순 병합보다는 공통 실행기(`SubAgentRunner`)를 추출하여 두 모듈이 공유하는 방식이 가장 현실적인 통합 방향.
