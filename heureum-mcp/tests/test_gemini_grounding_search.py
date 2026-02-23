"""Google Gemini Grounding Search 테스트 + Tavily 비교.

Usage:
    # Gemini grounding search만 테스트
    python -m tests.test_gemini_grounding_search

    # Tavily 비교 포함
    python -m tests.test_gemini_grounding_search --compare

환경변수 (.env에서 로드):
    GOOGLE_API_KEY      - Gemini API key (필수)
    TAVILY_API_KEY      - Tavily API key (--compare 시 필요)
"""

import asyncio
import json
import os
import sys
import time
from pathlib import Path

import httpx
from dotenv import load_dotenv

# ── .env 로드 (프로젝트 루트 → heureum-mcp → cwd 순서) ──
for env_path in [
    Path(__file__).resolve().parents[2] / ".env",   # repo root
    Path(__file__).resolve().parents[1] / ".env",   # heureum-mcp
]:
    if env_path.exists():
        load_dotenv(env_path)

from google import genai
from google.genai import types

# ── Config ──
GOOGLE_API_KEY = os.getenv("GOOGLE_API_KEY", "")
TAVILY_API_KEY = os.getenv("TAVILY_API_KEY", "")

GEMINI_MODEL = "gemini-2.5-flash"

TEST_QUERIES = [
    "2026년 한국 최저임금은 얼마인가요?",
    "latest Python 3.14 release date",
    "오늘 서울 날씨",
]


# =====================================================================
# Gemini Grounding Search
# =====================================================================

async def search_gemini_grounding(query: str, model: str = GEMINI_MODEL) -> dict:
    """Gemini + Google Search grounding으로 검색."""
    client = genai.Client(api_key=GOOGLE_API_KEY)

    config = types.GenerateContentConfig(
        tools=[types.Tool(google_search=types.GoogleSearch())],
    )

    start = time.monotonic()
    response = await client.aio.models.generate_content(
        model=model,
        contents=query,
        config=config,
    )
    elapsed_ms = int((time.monotonic() - start) * 1000)

    # 응답 파싱
    text = response.text or ""
    candidate = response.candidates[0] if response.candidates else None
    grounding_meta = getattr(candidate, "grounding_metadata", None)

    # 검색 소스 추출
    sources = []
    if grounding_meta:
        chunks = getattr(grounding_meta, "grounding_chunks", None) or []
        for chunk in chunks:
            web = getattr(chunk, "web", None)
            if web:
                sources.append({
                    "title": getattr(web, "title", ""),
                    "url": getattr(web, "uri", ""),
                })

    # search_entry_point (검색 위젯 HTML)
    search_entry = None
    if grounding_meta and getattr(grounding_meta, "search_entry_point", None):
        search_entry = getattr(
            grounding_meta.search_entry_point, "rendered_content", None
        )

    return {
        "provider": "gemini_grounding",
        "model": model,
        "query": query,
        "answer": text,
        "sources": sources,
        "source_count": len(sources),
        "took_ms": elapsed_ms,
        "has_search_widget": search_entry is not None,
    }


# =====================================================================
# Tavily Search (비교용)
# =====================================================================

async def search_tavily(query: str) -> dict:
    """Tavily REST API로 검색."""
    start = time.monotonic()
    async with httpx.AsyncClient() as http:
        resp = await http.post(
            "https://api.tavily.com/search",
            json={
                "query": query,
                "search_depth": "basic",
                "include_answer": False,
                "max_results": 5,
            },
            headers={"Authorization": f"Bearer {TAVILY_API_KEY}"},
            timeout=15.0,
        )
        resp.raise_for_status()
        data = resp.json()
    elapsed_ms = int((time.monotonic() - start) * 1000)

    results = data.get("results", [])
    return {
        "provider": "tavily",
        "query": query,
        "source_count": len(results),
        "sources": [{"title": r.get("title", ""), "url": r.get("url", "")} for r in results],
        "took_ms": elapsed_ms,
    }


# =====================================================================
# Display
# =====================================================================

def print_result(result: dict, indent: int = 2) -> None:
    """결과를 보기 좋게 출력."""
    prefix = " " * indent
    provider = result["provider"].upper()
    took = result["took_ms"]
    count = result["source_count"]

    print(f"{prefix}[{provider}] {took}ms | sources: {count}")

    if "answer" in result:
        answer_preview = result["answer"][:200].replace("\n", " ")
        print(f"{prefix}  Answer: {answer_preview}...")

    for i, src in enumerate(result.get("sources", [])[:3]):
        print(f"{prefix}  [{i+1}] {src.get('title', 'N/A')}")
        print(f"{prefix}      {src.get('url', 'N/A')}")
    print()


def print_comparison_table(gemini_results: list, tavily_results: list | None) -> None:
    """비교 요약 테이블 출력."""
    print("\n" + "=" * 70)
    print("  SUMMARY")
    print("=" * 70)

    headers = ["Query", "Gemini (ms)", "Sources"]
    if tavily_results:
        headers += ["Tavily (ms)", "Sources", "Speedup"]

    # 간단 테이블
    for i, g in enumerate(gemini_results):
        query_short = g["query"][:30]
        line = f"  {query_short:<32} Gemini: {g['took_ms']:>5}ms ({g['source_count']} src)"
        if tavily_results and i < len(tavily_results):
            t = tavily_results[i]
            speedup = t["took_ms"] / g["took_ms"] if g["took_ms"] > 0 else 0
            line += f"  |  Tavily: {t['took_ms']:>5}ms ({t['source_count']} src)"
            if speedup > 1:
                line += f"  → Gemini {speedup:.1f}x faster"
            else:
                ratio = g["took_ms"] / t["took_ms"] if t["took_ms"] > 0 else 0
                line += f"  → Tavily {ratio:.1f}x faster"
        print(line)

    # 평균
    avg_gemini = sum(r["took_ms"] for r in gemini_results) / len(gemini_results)
    print(f"\n  Gemini avg: {avg_gemini:.0f}ms")
    if tavily_results:
        avg_tavily = sum(r["took_ms"] for r in tavily_results) / len(tavily_results)
        print(f"  Tavily avg: {avg_tavily:.0f}ms")
        if avg_gemini < avg_tavily:
            print(f"  → Gemini {avg_tavily/avg_gemini:.1f}x faster on average")
        else:
            print(f"  → Tavily {avg_gemini/avg_tavily:.1f}x faster on average")
    print()


# =====================================================================
# Main
# =====================================================================

async def main_sequential(compare: bool = False) -> None:
    if not GOOGLE_API_KEY:
        print("ERROR: GOOGLE_API_KEY not set. Add it to .env")
        sys.exit(1)

    if compare and not TAVILY_API_KEY:
        print("WARNING: TAVILY_API_KEY not set. Skipping Tavily comparison.")
        compare = False

    print("=" * 70)
    print("  Gemini Grounding Search Test (Sequential)")
    print(f"  Model: {GEMINI_MODEL}")
    print(f"  Queries: {len(TEST_QUERIES)}")
    print(f"  Compare with Tavily: {compare}")
    print("=" * 70)
    print()

    gemini_results = []
    tavily_results = [] if compare else None

    for i, query in enumerate(TEST_QUERIES, 1):
        print(f"── Query {i}: {query}")

        # Gemini
        try:
            g_result = await search_gemini_grounding(query)
            gemini_results.append(g_result)
            print_result(g_result)
        except Exception as e:
            print(f"  [GEMINI ERROR] {type(e).__name__}: {e}\n")
            gemini_results.append({
                "provider": "gemini_grounding",
                "query": query,
                "took_ms": 0,
                "source_count": 0,
                "sources": [],
                "error": str(e),
            })

        # Tavily (비교)
        if compare:
            try:
                t_result = await search_tavily(query)
                tavily_results.append(t_result)
                print_result(t_result)
            except Exception as e:
                print(f"  [TAVILY ERROR] {type(e).__name__}: {e}\n")
                tavily_results.append({
                    "provider": "tavily",
                    "query": query,
                    "took_ms": 0,
                    "source_count": 0,
                    "sources": [],
                })

    # 요약
    valid_gemini = [r for r in gemini_results if r["took_ms"] > 0]
    valid_tavily = [r for r in (tavily_results or []) if r["took_ms"] > 0] or None
    if valid_gemini:
        print_comparison_table(valid_gemini, valid_tavily)


async def main_parallel() -> None:
    """3개 쿼리를 동시에 병렬 실행하여 속도 측정."""
    if not GOOGLE_API_KEY:
        print("ERROR: GOOGLE_API_KEY not set. Add it to .env")
        sys.exit(1)

    print("=" * 70)
    print("  Gemini Grounding Search — PARALLEL vs SEQUENTIAL")
    print(f"  Model: {GEMINI_MODEL}")
    print(f"  Queries: {len(TEST_QUERIES)}")
    print("=" * 70)

    # ── 1) Sequential ──
    print("\n▶ Sequential (one by one):")
    seq_results = []
    seq_start = time.monotonic()
    for query in TEST_QUERIES:
        try:
            r = await search_gemini_grounding(query)
            seq_results.append(r)
        except Exception as e:
            print(f"  [ERROR] {query[:30]}: {e}")
            seq_results.append({"query": query, "took_ms": 0, "source_count": 0, "sources": [], "provider": "gemini_grounding"})
    seq_total = int((time.monotonic() - seq_start) * 1000)

    for r in seq_results:
        print(f"  {r['query'][:40]:<42} {r['took_ms']:>5}ms  ({r['source_count']} src)")
    print(f"  {'TOTAL':<42} {seq_total:>5}ms")

    # ── 2) Parallel ──
    print("\n▶ Parallel (asyncio.gather):")
    par_start = time.monotonic()
    par_results = await asyncio.gather(
        *[search_gemini_grounding(q) for q in TEST_QUERIES],
        return_exceptions=True,
    )
    par_total = int((time.monotonic() - par_start) * 1000)

    for r in par_results:
        if isinstance(r, Exception):
            print(f"  [ERROR] {type(r).__name__}: {r}")
        else:
            print(f"  {r['query'][:40]:<42} {r['took_ms']:>5}ms  ({r['source_count']} src)")
    print(f"  {'TOTAL':<42} {par_total:>5}ms")

    # ── Summary ──
    print("\n" + "=" * 70)
    print("  PARALLEL vs SEQUENTIAL")
    print("=" * 70)
    print(f"  Sequential total: {seq_total:,}ms")
    print(f"  Parallel total:   {par_total:,}ms")
    if par_total > 0:
        speedup = seq_total / par_total
        print(f"  Speedup:          {speedup:.1f}x faster with parallel")
    print()


if __name__ == "__main__":
    if "--parallel" in sys.argv:
        asyncio.run(main_parallel())
    else:
        compare_flag = "--compare" in sys.argv
        asyncio.run(main_sequential(compare=compare_flag))
