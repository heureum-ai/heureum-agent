# skills_prompt 흐름 분석 및 use_server_guides 불필요 판단

> 분석 기준: `origin/feat/agentic-loop` 브랜치 (commit `4ca1753`)
> 작성일: 2026-02-26

---

## 1. skills_prompt 전체 데이터 흐름

```
heureum-client-tools/  (각 패키지별 SKILL.md 파일)
       ↓ export *_SKILLS
heureum-client/  (Electron main process에서 전체 합산)
       ↓ IPC → preload → window.api
heureum-frontend/  (React에서 API 요청에 포함)
       ↓ POST /api/v1/proxy/  { skills_snapshot: {...} }
heureum-platform/  (Django: DB 저장 + agent로 전달)
       ↓ POST /v1/responses  { skills_snapshot: {...} }
heureum-agent/  (FastAPI: skills_prompt 추출 → 시스템 프롬프트)
```

---

## 2. 단계별 상세

### 2-1. heureum-client-tools/ — 스킬 정의

각 패키지(`core`, `web`, `bash`, `coding`, `pdf`, `xlsx` 등)에 `skills/*/SKILL.md` 파일이 있고, YAML frontmatter 형식으로 작성:

```markdown
---
name: web
description: Web retrieval and extraction workflow
tools: web_init_task, web_write_source, web_fetch
---
(워크플로우 프롬프트 본문)
```

`parseSkillMd()` → `loadSkills()`로 파싱하여 `SkillDefinition[]` 배열로 export:

```typescript
// core/skills/index.ts
export interface SkillDefinition {
  name: string
  description: string
  tools: string[]
  workflowPrompt: string
}
```

### 2-2. heureum-client/ — 합산 + 스냅샷 생성

`src/main/tools.ts`에서 모든 패키지의 스킬을 하나로 합침:

```typescript
const ALL_SKILLS: SkillDefinition[] = [
  ...CORE_SKILLS, ...CODING_SKILLS, ...BASH_SKILLS,
  ...DOCX_SKILLS, ...WEB_SKILLS, ...PDF_SKILLS,
  ...PPT_SKILLS, ...XLSX_SKILLS, ...MD_SKILLS,
  ...HWPX_SKILLS, ...BROWSER_SKILLS,
]
```

`buildSkillsCatalog()`에서 XML 문자열 하나로 조립 — 이것이 `skills_prompt`:

```xml
<available_skills>
Below is the list of available skill packages. When you need to use
tools from a skill, first read its SKILL.md file to learn the workflow.

<skill name="interaction_task" description="..." location="~/.cache/heureum-skills/interaction_task/SKILL.md">
  tools: ask_question, select_cwd
</skill>
<skill name="web" description="..." location="~/.cache/heureum-skills/web/SKILL.md">
  tools: web_init_task, web_write_source, ...
</skill>
...
</available_skills>
```

`getSkillsSnapshot()`으로 최종 객체 생성:

```typescript
{
  version: "sha256해시앞16자",
  prompt: "<available_skills>...(위 XML)...</available_skills>",
  skills: [{ name, description, location, tools }, ...]
}
```

IPC(`ipcMain.handle('get-skills-snapshot')`)를 통해 프론트엔드에 전달.

### 2-3. heureum-frontend/ — API 요청에 포함

`src/lib/api.ts`에서:

```typescript
const snapshot = await window.api.getSkillsSnapshot();  // Electron IPC

const openRequest = {
  input: inputItems,
  tools,
  skills_snapshot: snapshot,  // ← 여기에 포함
  ...
};
await apiClient.post('/api/v1/proxy/', openRequest);
```

- 세션 캐싱: 한 세션에서 한 번만 전송 (`uploadedSkillsSnapshotSessions` Set으로 추적)
- 브라우저 전용 모드: Electron 없으면 `window.api`가 없으므로 `skills_snapshot = undefined`

### 2-4. heureum-platform/ — DB 저장 + agent 전달

`proxy/views.py` (126-135줄):

```python
incoming_snapshot = data.get("skills_snapshot")
if incoming_snapshot:
    # prompt(~14KB) 제거한 경량 버전만 DB에 저장
    lightweight = {k: v for k, v in incoming_snapshot.items() if k != "prompt"}
    session_obj.skills_snapshot = lightweight
    session_obj.save(...)
elif session_obj.skills_snapshot:
    # 후속 요청에 snapshot 없으면 DB에서 꺼내 재주입
    reinjected = dict(session_obj.skills_snapshot)
    reinjected.setdefault("prompt", "")  # ← 항상 빈 문자열
    data["skills_snapshot"] = reinjected
```

그 후 `data` 전체를 agent로 포워딩: `POST {AGENT_SERVICE_URL}/v1/responses`

### 2-5. heureum-agent/ — 추출 + 시스템 프롬프트 삽입

`routers/agent.py:208`:

```python
skills_prompt = SkillsSnapshot.extract_prompt(request.skills_snapshot)
# → snapshot.prompt 문자열 반환 (= <available_skills> XML 블록)
```

`open_responses.py:383-387`:

```python
@classmethod
def extract_prompt(cls, snapshot):
    if snapshot and snapshot.prompt:  # "" → falsy → None 반환
        return snapshot.prompt
    return None
```

→ `LoopContext.skills_prompt`에 저장 → 매 턴 `PromptController.build()` → `build_system_prompt(skills_prompt=...)` → 시스템 프롬프트에 `<available_skills>` 삽입

---

## 3. use_server_guides 분석

### 3-1. 원격 브랜치의 현재 코드

`controller.py`:

```python
effective_skills_prompt = skills_prompt

# OpenClaw-style snapshot mode: avoid injecting full SKILL.md bodies
# when <available_skills> is already present.
use_server_guides = not bool(effective_skills_prompt)

server_tool_prompts = (
    self.skill_provider.get_all_guide_prompts(skills_snapshot=skills_snapshot)
    if self.skill_provider and use_server_guides
    else []
)
```

의도: `<available_skills>` 카탈로그가 이미 있으면 서버 SKILL.md 본문(`<tool_guide>`)을 중복 주입하지 않겠다는 스위치.

### 3-2. 턴별 실제 동작

| 턴 | `skills_snapshot.prompt` | `skills_prompt` | `use_server_guides` | 서버 가이드 |
|---|---|---|---|---|
| **1번째** (Electron) | `<available_skills>...` (~14KB) | 비어있지 않음 | `False` | **생략** |
| **2번째~** (Electron) | `""` (platform이 strip 후 빈 문자열 재주입) | `None` (`extract_prompt`이 None 반환) | `True` | **주입** |
| **모든 턴** (웹 브라우저) | 없음 | `None` | `True` | **주입** |

### 3-3. 왜 첫 턴 이후 무력화되는가

1. Platform proxy가 DB 저장 시 `prompt` 키를 strip (`lightweight = {k: v for k, v in ... if k != "prompt"}`)
2. 후속 요청 시 `reinjected.setdefault("prompt", "")` → 빈 문자열
3. Agent에서 `extract_prompt()`이 빈 문자열을 falsy로 판단 → `None` 반환
4. `use_server_guides = not bool(None)` → `True`

---

## 4. 결론: use_server_guides는 불필요

### 판단 근거

| 관점 | 평가 |
|---|---|
| **토큰 절약** | 첫 턴에서만 서버 SKILL.md 생략. 2턴째부터 어차피 다 주입됨 → 효과 미미 |
| **중복 방지** | 첫 턴에서만 `<available_skills>` + `<tool_guide>` 중복 회피. 2턴째부터 `<available_skills>` 없이 `<tool_guide>`만 들어감 → 일관성 없음 |
| **웹 브라우저 모드** | `skills_prompt`가 항상 `None` → `use_server_guides` 항상 `True` → 이 로직 자체가 무의미 |
| **서브에이전트** | 부모의 `skills_prompt` 상속 → 첫 턴에서 스폰된 서브에이전트만 `False`, 이후 스폰은 `True` |
| **비대칭 제어** | `server_tool_prompts`(가이드)만 조건부, `server_tool_schemas`(스키마)는 항상 fetch → 절반만 제어 |

### 권장 조치

`use_server_guides` 조건을 제거하고, `skills_prompt` 유무와 관계없이 항상 서버 가이드를 주입:

```python
# Before (원격 브랜치)
use_server_guides = not bool(effective_skills_prompt)
...
if self.skill_provider and use_server_guides

# After (로컬 변경)
if self.skill_provider
```

이렇게 하면:
- 모든 턴에서 일관된 동작
- 웹/Electron 모드 간 차이 없음
- 서브에이전트 상속 시 예측 가능한 동작

---

## 참고 파일

| 파일 | 역할 |
|---|---|
| `heureum-client-tools/core/skills/index.ts` | SkillDefinition 인터페이스, parseSkillMd(), loadSkills() |
| `heureum-client/src/main/tools.ts:845-933` | ALL_SKILLS 합산, buildSkillsCatalog(), getSkillsSnapshot() |
| `heureum-client/src/preload/index.ts:105-111` | Electron IPC 브릿지 |
| `heureum-frontend/src/lib/api.ts:95-110` | resolveSkillsSnapshotForSession() |
| `heureum-platform/proxy/views.py:126-135` | DB 저장 + prompt strip + 재주입 |
| `heureum-agent/app/schemas/open_responses.py:368-387` | SkillsSnapshot 모델, extract_prompt() |
| `heureum-agent/app/routers/agent.py:207-234` | skills_prompt 추출 → LoopContext 설정 |
| `heureum-agent/app/services/prompts/controller.py:53-67` | use_server_guides 조건부 로직 |
| `heureum-agent/app/services/prompts/base.py:267-309` | build_system_prompt() — skills_prompt + server_tool_prompts 조립 |
| `heureum-agent/app/services/skills/controller.py:564-581` | get_all_guide_prompts() — SKILL.md 본문 로드 |
