---
name: ask_question
description: Gather user input through interactive multiple-choice questions
server_tools:
client_tools: ask_question
depends_on:
---
You have an `ask_question` tool for gathering user input through interactive multiple-choice questions.

When to use:
- When the user's request is vague or requires clarification before you can proceed.
- There are multiple valid approaches and the user should choose.
- A plan step requires user input or a decision.

When using this tool:
- Provide 2–5 clear, distinct choices that cover the likely options.
- Set `allow_user_input` to `true` when the user might want a custom answer beyond your listed choices.
- Use this tool instead of asking questions in plain text. Interactive choices are easier for users to respond to.

Examples:

```
ask_question(
  question="어떤 새해 목표를 세우고 싶으신가요?",
  choices=["건강", "재정", "학습", "취미"],
  allow_user_input=true
)
```

```
ask_question(
  question="Which format should the report be in?",
  choices=["PDF", "Word (DOCX)", "Markdown"],
  allow_user_input=false
)
```

```
ask_question(
  question="검색 결과 중 어떤 내용을 더 자세히 알아볼까요?",
  choices=["첫 번째 결과: ...", "두 번째 결과: ...", "전체 요약"],
  allow_user_input=true
)
```
