# Agentic Loop — Router & Agent Config 변경 사항

## 개요

요청을 분류(classify)하여 전문 에이전트(web_search, complex 등)로 라우팅하고,
에이전트별 시스템 프롬프트·도구 세트·반복 횟수를 적용하는 구조.

---

## 전체 워크플로 (Turn 1: 신규 요청)

```
┌─────────────────────────────────────────────────────────────────────┐
│  CLIENT (Electron / Web)                                            │
│  POST /v1/responses  { input, tools, skills_snapshot, stream }      │
└────────────────────────────┬────────────────────────────────────────┘
                             │
                             ▼
┌─────────────────────────────────────────────────────────────────────┐
│  1. HTTP Layer — router/agent.py::create_response()                 │
│                                                                     │
│  ① ensure_initialized()                                             │
│  ② session_id 추출, messages 파싱                                    │
│  ③ resolve_tools(request, session_id)                               │
│     ├─ client tools → tool_names, client_tool_schemas               │
│     ├─ skills_snapshot → Platform DB에서 SKILL.md body 조회          │
│     │   → client_tool_prompts에 <tool_guide> 추가                   │
│     ├─ missing tools → Platform DB에서 스키마 fetch                  │
│     └─ MCP tools → mcp_client.server_tool_names                     │
│  ④ _register_client_skills() → Platform DB에 skill body 저장        │
│  ⑤ MCP pending approval 처리 (있으면)                                │
│  ⑥ prepare_messages_for_session()                                   │
│     ├─ previous_response_id 있으면 → tool result를 히스토리에 병합   │
│     └─ 없으면 → 그대로 전달                                         │
│  ⑦ LoopContext 생성                                                  │
│     { messages, tool_names, client_tool_schemas,                    │
│       client_tool_prompts, skills_prompt, display_names }           │
│  ⑧ AgentLoopRunner(ctx) 생성                                        │
└────────────────────────────┬────────────────────────────────────────┘
                             │
                             ▼
┌─────────────────────────────────────────────────────────────────────┐
│  2. Runner — runner.py::run() / stream()                            │
│                                                                     │
│  ① _maybe_classify()                                                │
│     ├─ ctx.agent_config 이미 있음? → 그대로 사용                     │
│     ├─ _is_continuation()? → session에서 stored config 복원          │
│     └─ 신규 요청:                                                    │
│        ├─ classify_request(messages, registry, service)              │
│        │   → 경량 LLM 호출 → {"agent": "web_search"} 등             │
│        ├─ registry.get_agent(name) → AgentDefinition                │
│        ├─ _apply_agent_config(agent_def)                            │
│        │   ├─ skills 없으면 → tool_names 클리어, skills_prompt 제거  │
│        │   └─ skills 있으면 → skills_prompt 유지                     │
│        └─ controller.set_session_agent_config(session_id, def)      │
│                                                                     │
│  ② _should_use_tools?                                               │
│     ├─ tool_names 있음        → True                                │
│     ├─ agent_config.skills    → True                                │
│     ├─ agent_config.mcp_tools → True                                │
│     └─ 없으면                 → False                               │
│                                                                     │
│  ③ 분기                                                              │
│     ├─ False → _run_text_only()   ← simple 에이전트                  │
│     └─ True  → _run_tool_iterations()                               │
└────────────────────────────┬────────────────────────────────────────┘
                             │ _run_tool_iterations()
                             ▼
┌─────────────────────────────────────────────────────────────────────┐
│  3. Tool Loop — 최대 max_iterations 반복 (AGENT.md or 글로벌 50)     │
│                                                                     │
│  while iteration < max_iterations:                                  │
│    ┌────────────────────────────────────────────────────────┐       │
│    │  A. 프롬프트 + 도구 빌드                                │       │
│    │                                                        │       │
│    │  active_tool_names = skill_controller                  │       │
│    │    .get_active_tool_names(session_id, skills_snapshot)  │       │
│    │                                                        │       │
│    │  → AgentService.process_messages_with_tools()           │       │
│    │    → PromptController.prepare_prompt_and_tools(         │       │
│    │        agent_config=ctx.agent_config)                   │       │
│    │                                                        │       │
│    │    프롬프트 빌드:                                       │       │
│    │    ├─ agent_config 있음:                                │       │
│    │    │  ├─ get_guide_prompts_for_skills()                │       │
│    │    │  │   → 로컬 SKILL.md body → <tool_guide> 래핑     │       │
│    │    │  ├─ client_tool_prompts + server_guides 병합       │       │
│    │    │  └─ _build_agent_config_prompt()                  │       │
│    │    │     → SystemPromptBuilder(agent_identity=...)     │       │
│    │    └─ agent_config 없음:                               │       │
│    │       └─ build_system_prompt() (기존 방식)              │       │
│    │                                                        │       │
│    │    도구 해석:                                           │       │
│    │    ├─ agent_config 있음 → _resolve_agent_config_tools()│       │
│    │    │  ├─ skill_tool_names 추출                         │       │
│    │    │  ├─ client tools (skill 필터링)                   │       │
│    │    │  ├─ server skill tools                            │       │
│    │    │  └─ MCP tools (mcp_tools=true 시)                 │       │
│    │    ├─ is_subagent → _resolve_subagent_tools()          │       │
│    │    └─ main agent  → _resolve_main_agent_tools()        │       │
│    └────────────────────────────────────────────────────────┘       │
│                             │                                       │
│                             ▼                                       │
│    ┌────────────────────────────────────────────────────────┐       │
│    │  B. LLM 호출 → 결과 분기                                │       │
│    │                                                        │       │
│    │  result = LLM.call(system_prompt, messages, tools)      │       │
│    │                                                        │       │
│    │  ├─ TEXT 응답                                          │       │
│    │  │  ├─ 스킬 미완료 작업 있으면 → continue (다음 반복)  │       │
│    │  │  └─ 없으면 → COMPLETED 반환 (루프 종료)             │       │
│    │  │                                                     │       │
│    │  └─ TOOL_CALL 응답                                     │       │
│    │     → _handle_tool_call_iteration()                    │       │
│    └────────────────────────────────────────────────────────┘       │
│                             │                                       │
│                             ▼                                       │
│    ┌────────────────────────────────────────────────────────┐       │
│    │  C. 도구 실행 — _handle_tool_call_iteration()           │       │
│    │                                                        │       │
│    │  ① classify_tool_calls()                               │       │
│    │     ├─ client_calls: 클라이언트가 실행할 도구           │       │
│    │     └─ server_calls: 서버가 실행할 도구                 │       │
│    │                                                        │       │
│    │  ② unsupported 도구 → 에러 메시지 주입 → 다음 반복     │       │
│    │                                                        │       │
│    │  ③ MCP 승인 필요?                                      │       │
│    │     → INCOMPLETE 반환 (클라이언트에 승인 요청)           │       │
│    │     → session에 agent_config 저장 (Turn 2에서 복원)     │       │
│    │                                                        │       │
│    │  ④ 서버 도구 실행                                      │       │
│    │     execute_tool_calls_pipelined()                     │       │
│    │     → MCP 도구: mcp_client로 실행                      │       │
│    │     → Server skill 도구: skill_controller.execute_tool()│       │
│    │                                                        │       │
│    │  ⑤ 클라이언트 도구 있으면?                              │       │
│    │     → INCOMPLETE 반환 (클라이언트에 실행 위임)           │       │
│    │     예: web_fetch, read → Electron이 실행              │       │
│    │                                                        │       │
│    │  ⑥ 모두 서버 도구 → 결과를 messages에 추가 → 다음 반복 │       │
│    └────────────────────────────────────────────────────────┘       │
│                                                                     │
│  max_iterations 초과 → INCOMPLETE 반환                               │
└─────────────────────────────────────────────────────────────────────┘
```

## Continuation 플로우 (Turn 2+: 도구 결과 반환)

```
┌─────────────────────────────────────────────────────────────────────┐
│  CLIENT                                                             │
│  POST /v1/responses  { input: [tool_result],                        │
│                        previous_response_id: "resp_xxx" }           │
└────────────────────────────┬────────────────────────────────────────┘
                             │
                             ▼
┌─────────────────────────────────────────────────────────────────────┐
│  1. HTTP Layer                                                      │
│                                                                     │
│  ① resolve_tools(): skills_snapshot 없음 → 가이드 미로드            │
│  ② prepare_messages_for_session()                                   │
│     → tool result를 히스토리에 병합 → ctx.messages = [] (빈 리스트)  │
│  ③ LoopContext 생성 (tool_names 비어있을 수 있음)                    │
└────────────────────────────┬────────────────────────────────────────┘
                             │
                             ▼
┌─────────────────────────────────────────────────────────────────────┐
│  2. Runner                                                          │
│                                                                     │
│  ① _maybe_classify()                                                │
│     ├─ _is_continuation()                                           │
│     │  ├─ previous_response_id 있음? → True  ★핵심 수정             │
│     │  └─ (messages=[]이므로 ToolMessage 감지 불가)                  │
│     └─ stored config 복원                                           │
│        controller.get_session_agent_config(session_id)              │
│        → Turn 1에서 저장한 AgentDefinition (예: web_search)          │
│                                                                     │
│  ② _should_use_tools?                                               │
│     agent_config.skills="web_search_task" → True                    │
│                                                                     │
│  ③ _run_tool_iterations()                                           │
│     → PromptController에서 agent_config 기반으로 도구 해석           │
│     → SKILL.md 가이드 서버 측 주입 (skills_snapshot 없어도)          │
│     → MCP 도구 필터 없이 포함 (agent_config.mcp_tools=True)         │
│     → LLM이 도구 결과 + 히스토리 기반으로 최종 응답 생성             │
└─────────────────────────────────────────────────────────────────────┘
```

## 에이전트별 동작 예시

### simple 에이전트 — "안녕하세요"
```
classify → "simple" → skills=[], mcp_tools=false
→ _apply_agent_config: tool_names 클리어
→ _should_use_tools = False
→ _run_text_only(agent_config) → 단일 LLM 호출 → COMPLETED
```

### web_search 에이전트 — "오늘 서울 날씨"
```
classify → "web_search" → skills=[web_search_task], mcp_tools=true, max_iterations=8

Turn 1:
→ _resolve_agent_config_tools: web_fetch, read (client) + mcp_web__search (MCP)
→ LLM calls mcp_web__search → 승인 필요 → INCOMPLETE (승인 요청)
                          또는 LLM calls web_fetch → INCOMPLETE (클라이언트 실행 위임)

Turn 2 (continuation):
→ _is_continuation: previous_response_id 존재 → True
→ stored config 복원: web_search
→ LLM이 검색 결과로 답변 생성 → COMPLETED
```

### complex 에이전트 — "한국과 일본 경제 비교 분석"
```
classify → "complex" → skills=[plan_task, ...], mcp_tools=true, max_iterations=30

Turn 1:
→ _resolve_agent_config_tools: plan 도구 + MCP 도구 + client 도구
→ LLM이 계획 생성 → 도구 호출 → 다단계 반복 → COMPLETED
```

---

## 변경 파일 목록

| 파일 | 역할 | 변경 내용 |
|------|------|-----------|
| `context.py` | LoopContext 데이터 | `agent_config` 필드 추가 |
| `controller.py` | AgentLoopController | AgentRegistry 초기화, 세션별 agent_config 저장/복원 |
| `runner.py` | AgentLoopRunner | 라우터 분류, continuation 감지, 도구 사용 판단, max_iterations |
| `agent_service.py` | AgentService | `agent_config` 파라미터 전파 (4개 메서드) |
| `prompts/base.py` | SystemPromptBuilder | `agent_identity` 파라미터 지원 |
| `prompts/controller.py` | PromptController | 3가지 도구 해석 전략, 에이전트 프롬프트 빌더, 가이드 주입 |
| `skills/controller.py` | SkillController | `get_skill_tool_names()`, `get_guide_prompts_for_skills()` |
| `tests/test_persist_hooks.py` | 테스트 | 라우터 분류 mock 패치 |
| `tests/test_router_endpoint.py` | 테스트 | 라우터 분류 mock 패치 |

---

## 1. LoopContext — `context.py`

```python
# 추가된 필드
agent_config: Optional["AgentDefinition"] = None
```

- 라우터가 선택한 `AgentDefinition`을 루프 전체에서 참조

---

## 2. AgentLoopController — `controller.py`

### 2-1. AgentRegistry 초기화
```python
self.agent_registry = AgentRegistry()  # AGENT.md 자동 탐색
```

### 2-2. 세션별 agent_config 저장/복원
```python
_session_agent_config: Dict[str, "AgentDefinition"]

def get_session_agent_config(session_id) → AgentDefinition | None
def set_session_agent_config(session_id, config) → None
```

- Turn 1에서 분류 결과를 저장
- Turn 2 (continuation)에서 복원하여 동일 에이전트 유지
- `cleanup_stale_locks()`와 `remove_session_lock()`에서 함께 정리

---

## 3. AgentLoopRunner — `runner.py` (핵심)

### 3-1. `_is_continuation()` — Continuation 감지

```python
def _is_continuation(self) -> bool:
    # 1. MCP 승인 대기 중
    if self._mcp_client.has_pending_approval(session_id): return True
    # 2. 클라이언트가 previous_response_id를 참조
    if getattr(self.ctx.request, "previous_response_id", None): return True
    # 3. 입력에 ToolMessage 존재
    for m in self.ctx.messages:
        if isinstance(m, ToolMessage): return True
    return False
```

**수정된 버그**: `prepare_messages_for_session`이 tool result를 히스토리에 병합 → `self.ctx.messages`가 빈 리스트 → ToolMessage 감지 실패.
**해결**: `previous_response_id` 존재 시 continuation으로 판단.

### 3-2. `_maybe_classify()` — 라우터 분류

```
                ┌─ agent_config 이미 있음? → _apply_agent_config() → return
                │
run() ─────────┤
                │  ┌─ _is_continuation()? → session에서 stored config 복원 → return
                │  │
                └──┤
                   └─ classify_request() → AgentRegistry에서 agent_def 조회
                      → _apply_agent_config() → session에 저장
```

### 3-3. `_should_use_tools` — 도구 사용 판단

```python
@property
def _should_use_tools(self) -> bool:
    if self.ctx.tool_names:                   return True  # 기존 방식
    if config.skills or config.mcp_tools:     return True  # agent_config 기반
    return False
```

**수정된 버그**: continuation에서 `tool_names=[]` → `_run_text_only()` 진입.
**해결**: `agent_config`에 skills/mcp_tools가 있으면 도구 사용.

### 3-4. `_apply_agent_config()` — 에이전트 설정 적용

```python
def _apply_agent_config(self, config: AgentDefinition):
    # 도구 없는 에이전트: tool_names 클리어 → _run_text_only
    if not config.skills and not config.mcp_tools:
        self.ctx.tool_names = []
        self.ctx.skills_prompt = None
        return
    # 스킬 카탈로그 불필요 시 숨김
    if not config.skills:
        self.ctx.skills_prompt = None
```

### 3-5. `_max_iterations` — 에이전트별 반복 횟수

```python
@property
def _max_iterations(self) -> int:
    if self.ctx.agent_config and self.ctx.agent_config.max_iterations:
        return self.ctx.agent_config.max_iterations  # AGENT.md의 max_iterations
    return settings.MAX_AGENT_ITERATIONS              # 글로벌 설정 (50)
```

- `_run_tool_loop()`, `_stream_tool_loop()`, `_build_max_iterations_response()` 모두 적용

### 3-6. 진입점 변경

```python
# run() 및 stream() 모두:
async def run(self):
    await self._maybe_classify()            # 추가
    if not self._should_use_tools:          # 변경 (기존: not self.ctx.tool_names)
        response = await self._run_text_only()
    else:
        ...
```

---

## 4. AgentService — `agent_service.py`

`agent_config` 파라미터를 4개 메서드에 추가하여 PromptController까지 전달:

| 메서드 | 역할 |
|--------|------|
| `prepare_prompt_and_tools()` | 프롬프트 + 도구 스키마 빌드 |
| `process_with_tools()` | 도구 포함 LLM 호출 |
| `process_text_only()` | 도구 없는 LLM 호출 |
| `stream_llm_response()` | 스트리밍 LLM 호출 |

---

## 5. SystemPromptBuilder — `prompts/base.py`

```python
def __init__(self, *, is_subagent=False, agent_identity=None):
    self._agent_identity = agent_identity

def build(self):
    if self._agent_identity:      identity = self._agent_identity      # AGENT.md
    elif self._is_subagent:       identity = SUBAGENT_IDENTITY_PROMPT
    else:                         identity = AGENT_IDENTITY_PROMPT     # 기본
```

---

## 6. PromptController — `prompts/controller.py` (핵심)

### 6-1. 3가지 도구 해석 전략

```
prepare_prompt_and_tools()
    │
    ├─ agent_config 있음 → _resolve_agent_config_tools()    신규
    ├─ is_subagent       → _resolve_subagent_tools()        신규 (기존 로직 분리)
    └─ main agent        → _resolve_main_agent_tools()      신규 (기존 로직 분리)
```

### 6-2. `_resolve_agent_config_tools()` — 라우팅된 에이전트용

```python
def _resolve_agent_config_tools(self, agent_config, ...):
    # 1. agent_config.skills에서 허용 도구 이름 추출
    skill_tool_names = self.skill_provider.get_skill_tool_names(allowed_skills)

    # 2. Client 도구 — skill_tool_names로 필터링
    for t in client_tool_schemas:
        if name not in skill_tool_names: continue    # ask_question 등 제외

    # 3. Server skill 도구 — 허용된 스킬만
    for t in server_tool_schemas:
        if name in skill_tool_names: tools.append(t)

    # 4. MCP 도구 — agent_config.mcp_tools=True 시 전부 포함
    #    active_tool_names 필터 미적용 (continuation에서 MCP 도구 손실 방지)
    if agent_config.mcp_tools:
        for t in mcp_tool_controller.get_tool_schemas(): tools.append(t)
```

**수정된 버그 1 — MCP 도구 필터링**:
- `active_tool_names`는 server skill 도구만 포함, MCP 도구는 미포함
- Turn 2에서 `skills_snapshot` 없음 → MCP 도구가 `active_tool_names`에 없음 → 전부 제거 → `tool_count=0`
- 수정: `agent_config.mcp_tools=True`이면 추가 필터링 없이 MCP 도구 포함

**수정된 버그 2 — Client 도구 과다 포함**:
- 기존: 모든 client 도구를 필터 없이 포함
- `web_search` 에이전트가 `ask_question` 등도 수신 → INCOMPLETE → 파일 선택기 표시
- 수정: `skill_tool_names`로 client 도구도 필터링

### 6-3. `_build_agent_config_prompt()` — 에이전트 프롬프트

```python
@staticmethod
def _build_agent_config_prompt(agent_config, client_tool_prompts, ...):
    builder = SystemPromptBuilder(agent_identity=agent_config.identity_prompt)
    # skills_catalog, tool_guides, state_prompts, instructions 조합
```

### 6-4. SKILL.md 가이드 주입 (continuation 보장)

```python
if agent_config.skills and self.skill_provider:
    server_guides = self.skill_provider.get_guide_prompts_for_skills(
        set(agent_config.skills)
    )
    for guide in server_guides:
        if guide not in existing:
            merged_prompts.append(guide)
```

- Continuation에서 `skills_snapshot` 없음 → Platform DB 가이드 미로드
- 서버 측 SKILL.md 본문을 직접 주입하여 가이드 유지

---

## 7. SkillController — `skills/controller.py`

### 7-1. `get_skill_tool_names(skill_names)` → `Set[str]`
```
alias 해석 → _tools_by_skill에서 도구 이름 합집합 반환
```
- `_resolve_agent_config_tools()`에서 도구 필터링에 사용

### 7-2. `get_guide_prompts_for_skills(skill_names)` → `List[str]`
```
로컬 SKILL.md 본문 → <tool_guide> 래핑하여 반환
```
- `prepare_prompt_and_tools()`에서 continuation 가이드 주입에 사용

---

## 8. 테스트 — `test_persist_hooks.py`, `test_router_endpoint.py`

기존 테스트가 라우터 분류 없이 동작하도록 mock 패치:
```python
# AgentRegistry mock
mock_registry.get_agent.return_value = None
monkeypatch.setattr(ctrl, "agent_registry", mock_registry)

# classify_request → None 반환
monkeypatch.setattr(runner_mod, "classify_request", _noop_classify)
```

---

## 플로우 다이어그램

```
Client Request
    │
    ▼
router/agent.py (HTTP) → resolve_tools() → LoopContext 생성
    │
    ▼
AgentLoopRunner.run() / stream()
    │
    ├─ _maybe_classify()
    │   ├─ agent_config 이미 있음? → 그대로 사용
    │   ├─ continuation? → 세션에서 복원
    │   └─ 신규? → classify_request() → AgentRegistry → 저장
    │
    ├─ _should_use_tools?
    │   ├─ No  → _run_text_only(agent_config 전달)
    │   └─ Yes → _run_tool_loop()
    │           │
    │           ▼
    │     PromptController.prepare_prompt_and_tools(agent_config)
    │           │
    │           ├─ _build_agent_config_prompt()   ← AGENT.md identity
    │           ├─ guide injection                ← SKILL.md body
    │           └─ _resolve_agent_config_tools()
    │               ├─ client tools (filtered by skill)
    │               ├─ server skill tools
    │               └─ MCP tools (if mcp_tools=true)
    │
    ▼
LLM Call → Tool Execution → ... → Response
```

---

## 수정된 버그 요약

| 버그 | 원인 | 수정 |
|------|------|------|
| Continuation에서 `tool_count=0` | `active_tool_names`가 MCP 도구를 필터링 | `_resolve_agent_config_tools`에서 MCP 필터 제거 |
| Continuation 미감지 (`simple` 재분류) | `prepare_messages_for_session`이 messages를 비움 → `_is_continuation()` = False | `previous_response_id` 체크 추가 |
| 파일 선택기 표시 | `web_search` 에이전트에 `ask_question` 도구 포함 | `skill_tool_names`로 client 도구 필터링 |
| Continuation에서 SKILL.md 가이드 누락 | `skills_snapshot` 없어서 DB 가이드 미로드 | 서버 측 SKILL.md 직접 주입 |
| max_iterations 무시 | AGENT.md 설정이 글로벌 설정(50) 사용 | `_max_iterations` 프로퍼티로 agent_config 우선 적용 |

---

## 미해결 이슈

| 이슈 | 설명 |
|------|------|
| `mcp_web__search` API 키 | Tavily/OpenAI 키 미설정 시 에러 반환. 가이드가 search→fetch→read 순서를 강제하여 LLM이 `web_fetch` 직접 호출 불가 |
| 디버그 로그 정리 | `runner.py`의 CLASSIFY, SHOULD_USE_TOOLS 등 `logger.info` → 안정화 후 `logger.debug`로 변경 필요 |
