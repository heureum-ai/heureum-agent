# Travel Task Skill — 코드 변경 내역 정리

## 최신 변경: 항공편 검색 — Aviasales MCP → fast-flights 내장 도구

### 변경 이유
- Aviasales MCP 서버(`https://findflights.me/sse`)가 404 (서버 다운)으로 항공편 검색 불가
- `fast-flights` Python 라이브러리(Google Flights 스크래핑, API 키 불필요)로 대체

### 변경 내용 (4개 파일)

| 파일 | 변경 유형 | 핵심 요약 |
|------|-----------|-----------|
| `app/skills/travel_task/service.py` | Modified | `travel_search_flights` 도구 추가 (스키마 + 핸들러) |
| `app/config.py` | Modified | `MCP_SERVER_URLS`에서 `findflights.me/sse` 제거 |
| `app/skills/travel_task/SKILL.md` | Modified | Flight Search 섹션을 `travel_search_flights` 도구 문서로 교체 |
| `TRAVEL_TASK_CHANGES.md` | Modified | 이 항목 추가 |

### 새 도구: `travel_search_flights`
- **라이브러리**: `fast-flights` (Google Flights 스크래핑)
- **API 키**: 불필요
- **파라미터**: origin, destination, date, return_date, seat, passengers, max_results
- **왕복 지원**: `return_date` 설정 시 FlightData 2개로 왕복 검색
- **비동기 처리**: `asyncio.to_thread(get_flights, ...)` — 동기 함수 blocking 방지
- **결과**: airline, departure, arrival, duration, stops, price (JSON)

---

## 초기 구현 변경 파일 요약 (9개 파일, +160 / -25)

| 파일 | 변경 유형 | 핵심 요약 |
|------|-----------|-----------|
| `heureum-agent/app/config.py` | Modified | `GOOGLE_MAPS_API_KEY` 추가 |
| `heureum-agent/app/services/mcps/connection.py` | Modified | SSE 전송 프로토콜 자동 감지 |
| `heureum-agent/app/services/prompts/controller.py` | Modified | 스킬 가이드 프롬프트 항상 주입 |
| `heureum-agent/app/skills/travel_task/` | **New** | 전체 travel_task 스킬 (SKILL.md + service.py) |
| `heureum-frontend/package.json` | Modified | leaflet, react-leaflet 의존성 추가 |
| `heureum-frontend/src/components/chat/PlacesMap.tsx` | **New** | Leaflet 기반 인터랙티브 지도 컴포넌트 |
| `heureum-frontend/src/components/chat/ToolBlock.tsx` | Modified | 장소검색/일정 결과에 지도 자동 렌더링 |
| `heureum-frontend/src/pages/ChatPage.css` | Modified | 지도 컨테이너 CSS 추가 |
| `heureum-client-tools/core/package.json` | Modified | ESM `import` 조건부 export 추가 |
| `heureum-platform/session_files/storage.py` | Modified | 파일 저장 race condition 재시도 로직 |

---

## 아키텍처 변경 흐름

```
                         ┌──────────────────────────────────┐
                         │         config.py 변경            │
                         │  + GOOGLE_MAPS_API_KEY            │
                         │  + Aviasales MCP URL              │
                         └────────┬────────────┬────────────┘
                                  │            │
                    ┌─────────────▼──┐    ┌────▼──────────────┐
                    │ MCP Connection  │    │  Prompt Controller │
                    │ SSE 자동 감지   │    │ 스킬 가이드 항상   │
                    │ /sse → SSE      │    │ 주입 (조건 제거)   │
                    │ else → HTTP     │    └───────────────────┘
                    └────────────────┘
                                  │
         ┌────────────────────────▼───────────────────────────┐
         │              travel_task Skill (NEW)                │
         │                                                     │
         │  ┌───────────────┐  ┌────────────────┐             │
         │  │ get_weather    │  │ search_places   │             │
         │  │ (Open-Meteo)   │  │ (Google Maps)   │             │
         │  │ 무료, 키 불필요 │  │ Places API v1   │             │
         │  └───────────────┘  └────────────────┘             │
         │  ┌───────────────┐  ┌────────────────┐             │
         │  │ get_directions │  │ search_flights  │             │
         │  │ (Google Maps)  │  │ (fast-flights)  │             │
         │  │ Directions API │  │ 무료, 키 불필요  │             │
         │  └───────────────┘  └────────────────┘             │
         │  ┌────────────────┐                                │
         │  │ manage_itinerary│                                │
         │  │ (In-memory CRUD)│                                │
         │  │ 세션별 상태관리  │                                │
         │  └────────────────┘                                │
         └─────────────────────────┬───────────────────────────┘
                                   │ JSON output
                    ┌──────────────▼──────────────┐
                    │   Frontend 지도 렌더링        │
                    │                              │
                    │  ToolBlock.tsx → PlacesMap    │
                    │  (Leaflet lazy-loaded)        │
                    │  + ChatPage.css 지도 스타일   │
                    └──────────────────────────────┘
```

---

## 주요 변경 상세

### 1. Agent 설정 (`config.py`)

```diff
+ GOOGLE_MAPS_API_KEY: str = ""          # 장소검색/길찾기 API 키
```

- Google Maps Places/Directions API 키 설정 추가
- 항공편 검색: Aviasales MCP 서버 제거 → `travel_search_flights` 내장 도구로 대체

### 2. MCP 연결 — SSE 전송 자동 감지 (`connection.py`)

```
URL 패턴별 자동 분기:
  /sse 로 끝남 → sse_client() 사용
  그 외         → streamable_http_client() + /mcp 경로
```

- `_is_sse_url()` 함수 추가: URL path가 `/sse`로 끝나면 SSE 모드
- Aviasales 같은 외부 MCP 서버(SSE 방식)와 내부 서버(streamable-http) 동시 지원

### 3. 프롬프트 컨트롤러 (`controller.py`)

```diff
- use_server_guides = not bool(effective_skills_prompt)
- if self.skill_provider and use_server_guides
+ if self.skill_provider
```

- **조건 제거**: 이전에는 `skills_prompt`가 있으면 서버 가이드를 생략했으나, 이제 **항상 주입**
- travel_task의 SKILL.md 프롬프트가 확실히 LLM에 전달되도록 보장

### 4. Travel Task 스킬 (NEW: `travel_task/`)

#### 5개 도구 구성

| 도구 | 외부 API | 키 필요 | 기능 |
|------|----------|---------|------|
| `travel_get_weather` | Open-Meteo | 없음 | 최대 16일 날씨 예보 (기온, 강수, 풍속) |
| `travel_search_places` | Google Maps Places v1 | `GOOGLE_MAPS_API_KEY` | 장소 검색 + 리뷰 + 가격 + 영업시간 + 좌표 |
| `travel_get_directions` | Google Maps Directions | `GOOGLE_MAPS_API_KEY` | 경로/소요시간/대중교통 상세 |
| `travel_search_flights` | Google Flights (fast-flights) | 없음 | 항공편 검색 (항공사, 시간, 가격, 경유) |
| `travel_manage_itinerary` | 없음 (in-memory) | 없음 | 세션별 일정 CRUD + map_places 출력 |

#### 데이터 모델

```
Itinerary
  ├── title, destination, start_date, end_date
  └── days: Dict[int, DayPlan]
        └── activities: List[Activity]
              ├── id, time, name, location, duration
              ├── category (food/sightseeing/transport/shopping/rest/accommodation)
              ├── estimated_cost, rating, price_level
              ├── lat, lon, maps_url, website
              └── review_summary
```

#### 핵심 기능 흐름

```
1. 날씨 확인    → travel_get_weather(location, forecast_days)
                   ↓ Open-Meteo geocoding → forecast API
                   ↓ WMO 코드 → 사람이 읽을 수 있는 날씨

2. 장소 검색    → travel_search_places(query, location, max_results)
                   ↓ Google Places Text Search (v1 신규 API)
                   ↓ 리뷰 3개 + editorial_summary + 좌표
                   ↓ JSON → 프론트엔드 Leaflet 지도 자동 렌더링

3. 길찾기       → travel_get_directions(origin, destination, mode)
                   ↓ Google Directions API
                   ↓ 대중교통 노선/정류장 상세 포함
                   ↓ Google Maps URL 자동 생성

4. 일정 관리    → travel_manage_itinerary(action, ...)
                   create → add_activity x N → view
                   ↓ view 호출 시 map_places 배열 출력
                   ↓ 프론트엔드 지도에 전체 일정 마커 표시
```

### 5. 프론트엔드 — 인터랙티브 지도 (`PlacesMap.tsx`)

```
새 컴포넌트: PlacesMap.tsx (160줄)
├── Leaflet + OpenStreetMap 타일
├── react-leaflet <MapContainer> + <Marker> + <Popup>
├── 자동 bounds fitting (모든 마커 포함)
└── Popup 내용:
    ├── 장소명 + 가격대
    ├── 주소 + 별점 + 리뷰수
    ├── editorial_summary
    ├── 영업시간 (첫째줄 + "more" 표시)
    ├── 리뷰 최대 3개 (작성자, 별점, 텍스트 100자)
    └── Google Maps / Website 링크
```

### 6. ToolBlock 통합 (`ToolBlock.tsx`)

```
도구 결과 렌더링 분기:
  travel_search_places      → PlacesMap (lazy-loaded)
  travel_manage_itinerary   → map_places 있으면 PlacesMap
    (action=view)
  manage_periodic_task      → PeriodicTaskResult (기존)
  기타                      → <pre> raw output
```

- `Suspense` + `lazy()` 로 Leaflet 번들 지연 로딩
- `.ac-tool-has-map` 클래스로 지도 있는 도구 결과 전폭 표시

### 7. CSS 지도 스타일 (`ChatPage.css`)

```css
.ac-tool-has-map  { width: 100%; max-width: 100%; }
.ac-tool-map      { height: 280px; border-radius: 8px; }
```

### 8. Platform 파일 저장 안정성 (`storage.py`)

```
기존: save → exists → delete → save (1회)
변경: save → retry 3회 (50ms 간격)
      FileNotFoundError 시 재시도 (동시 요청 race condition 대응)
```

### 9. Client Tools 패키지 (`core/package.json`)

```diff
+ "import": {
+   "types": "./dist/browser.d.ts",
+   "default": "./dist/browser.js"
+ },
```

- ESM `import` 조건부 export 추가 → 프론트엔드 번들러가 브라우저 전용 엔트리 사용

---

## 의존성 변경

| 패키지 | 버전 | 용도 |
|--------|------|------|
| `leaflet` | ^1.9.4 | 지도 라이브러리 |
| `react-leaflet` | ^5.0.0 | React Leaflet 바인딩 |
| `@types/leaflet` | ^1.9.21 | TypeScript 타입 |

---

## SKILL.md 주요 가이드 요약

| 섹션 | 내용 |
|------|------|
| Core Principles | 10가지 원칙 (proactive, describe, reviews as intelligence, show on map 등) |
| Quick Recommendation | 단일 질의 → 검색 → 리뷰 분석 → 경로 제안 |
| Full Trip Planning | 5 Phase (이해 → 리서치 → 분석/클러스터링 → 일정 구축 → 최종 발표) |
| Time-of-Day Scheduling | 시간대별 최적 활동 배치 테이블 |
| Meal Placement | 식사 = 휴식 + 전환점, 클러스터별 음식 검색 필수 |
| Stamina Management | 에너지 곡선, 강도 분류 (High/Medium/Low), 하루 5-6개 활동 제한 |
| Flight Search | `travel_search_flights` 내장 도구 (fast-flights, 편도/왕복) |
| Weather Adaptation | 날씨별 실내/실외 전환, 혼잡도 패턴 대응 |
| Review Analysis | editorial_summary 기반 + 리뷰 종합 → 풍부한 장소 설명 |
