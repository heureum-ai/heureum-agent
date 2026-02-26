# Prompt Snapshot Mode Explained

아래 설명은 `app/services/prompts/controller.py`의 이 부분을 이해하기 위한 문서입니다.

```python
effective_skills_prompt = skills_prompt

# OpenClaw-style snapshot mode: avoid injecting full SKILL.md bodies
# when <available_skills> is already present.
use_server_guides = not bool(effective_skills_prompt)

server_tool_prompts = (
    (
        self.skill_provider.get_all_guide_prompts(
            skills_snapshot=skills_snapshot,
        )
        if self.skill_provider and use_server_guides
        else []
    )
)
```

## 1) 한 줄 의미 요약

- `use_server_guides = not bool(effective_skills_prompt)`는
  - `skills_prompt`가 있으면 `False`
  - `skills_prompt`가 없으면 `True`
  가 됩니다.
- 즉, 이미 `<available_skills>`가 있으면 서버 SKILL.md 본문 가이드(`server_tool_prompts`)를 다시 넣지 않겠다는 스위치입니다.

## 2) 왜 이런 스위치가 필요한가

### 배경

- `skills_prompt`는 클라이언트가 만든 `<available_skills>` 카탈로그입니다.
- 서버는 원래 `get_all_guide_prompts(...)`로 SKILL.md 본문을 `<tool_guides>`로 넣습니다.

둘 다 동시에 넣으면 다음 문제가 생길 수 있습니다.

1. 같은 스킬 정보가 중복됨
2. 프롬프트 길이(토큰) 증가
3. 지시가 중복/충돌할 가능성 증가

그래서 snapshot mode에서는 `<available_skills>`를 "요약 인덱스"로 쓰고, 상세 SKILL.md 주입은 생략하려는 것입니다.

## 3) 실제 분기 예시

### 케이스 A: `skills_prompt`가 있는 경우

```python
skills_prompt = "<available_skills>...</available_skills>"
use_server_guides = not bool(skills_prompt)  # False
```

결과:

- `server_tool_prompts = []`
- 시스템 프롬프트에는 `<available_skills>`는 들어가지만, 서버 `<tool_guides>`는 빠짐
- 프롬프트가 짧아지고 중복이 줄어듦

### 케이스 B: `skills_prompt`가 없는 경우

```python
skills_prompt = None
use_server_guides = not bool(skills_prompt)  # True
```

결과:

- `server_tool_prompts = get_all_guide_prompts(...)`
- 서버 SKILL.md 기반 `<tool_guides>`가 포함됨
- 기존 동작(레거시)과 유사

## 4) "이전 코드"(조건 없이 주입)와의 차이

질문에서 붙여준 이전 형태는 아래와 같습니다.

```python
server_tool_prompts = (
    (
        self.skill_provider.get_all_guide_prompts(
            skills_snapshot=skills_snapshot,
        )
        if self.skill_provider
        else []
    )
)
```

이 코드의 핵심은 `skills_prompt` 유무를 보지 않는다는 점입니다.

### 이전 코드에서 생길 수 있는 현상

1. `skills_prompt`가 있어도 서버 guide를 계속 넣음
2. `<available_skills>` + `<tool_guides>` 동시 주입으로 길어짐
3. 같은 스킬 정보가 두 경로로 들어와 모델이 과도한 지시를 받음

즉, "스냅샷 모드"를 의도해도 실제론 완전히 적용되지 않은 상태가 됩니다.

## 5) 최종 시스템 프롬프트에서 어떤 차이가 보이나

`build_system_prompt(...)`는 섹션을 대략 아래 순서로 조립합니다.

1. identity
2. `<available_skills>` (있을 때)
3. `<tool_guides>` (guide가 있을 때)
4. `<session_state>`
5. `<instructions>`
6. `<current_date>`

따라서 `use_server_guides`를 적용하면 아래 변화가 생깁니다.

- `skills_prompt` 있음: 2번은 유지, 3번(서버 guide)은 비워질 가능성 큼
- `skills_prompt` 없음: 3번이 기존처럼 채워짐

## 6) 오해하기 쉬운 포인트

### "skills_prompt가 있으면 무조건 가이드가 0개인가?"

- 서버 가이드는 비울 수 있지만, `client_tool_prompts`가 있으면 `<tool_guides>`가 완전히 사라지지 않을 수 있습니다.

### "skills_snapshot은 무슨 역할인가?"

- 서버에서 `get_all_guide_prompts(skills_snapshot=...)` 필터링에 사용됩니다.
- 즉, 활성 스킬/허용 도구 기준으로 어떤 가이드를 넣을지 선별합니다.

## 7) 실무적으로 기억할 결론

- 이 스위치는 "중복 주입 방지 + 토큰 절약"을 위한 장치입니다.
- 스냅샷 품질이 충분히 좋다면 이 방식이 더 효율적입니다.
- 반대로 스냅샷이 부실하면 상세 가이드를 빼면서 품질 저하가 날 수 있어, snapshot 생성 품질이 중요합니다.

---

## 참고 코드 위치

- `app/services/prompts/controller.py`
- `app/services/prompts/base.py`
- `app/services/skills/controller.py`
- `app/schemas/open_responses.py`
