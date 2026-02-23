# 웹 PDF 뷰어 및 PDF.js 가이드

## 웹 PDF 임베딩 방법

| 방법 | 장점 | 단점 |
|------|------|------|
| `<iframe>` | 간단, 브라우저 내장 뷰어 사용 | 커스터마이즈 제한적 |
| `<object>` | HTML5, 폴백 콘텐츠 지원 | 브라우저별 동작 차이 |
| `<embed>` | 직접 임베딩 | 폴백 미지원 |
| **JavaScript 라이브러리** | 완전한 제어, 기능 확장 | 구현 복잡도 |

## 웹 뷰어 필수 기능

### 탐색 (Navigation)
- 페이지 이동 (처음, 마지막, 이전, 다음)
- 페이지 번호 직접 입력
- 썸네일 사이드바
- 북마크/목차 탐색

### 뷰 (View)
- 확대/축소 (줌 인/아웃, 커스텀 비율)
- 페이지 맞춤 (페이지, 너비, 보이는 영역)
- 레이아웃 모드 (단일, 연속, 양면, 양면 연속)
- 전체 화면/프레젠테이션 모드
- 반응형/모바일 지원

### 상호작용 (Interaction)
- 텍스트 선택 및 복사
- 문서 내 검색
- 주석 보기
- 인쇄 지원
- 다운로드 옵션

---

## PDF.js 아키텍처

```
┌─────────────────────────────────────────┐
│            Viewer Layer                  │
│    (완전한 UI 컴포넌트)                    │
│    PDFViewerApplication                  │
├─────────────────────────────────────────┤
│           Display Layer                  │
│    (렌더링 API)                           │
│    pdfjsLib.getDocument()                │
├─────────────────────────────────────────┤
│            Core Layer                    │
│    (PDF 구조 파싱)                        │
│    저수준 PDF 파싱                        │
└─────────────────────────────────────────┘
```

### 3가지 렌더링 레이어

| 레이어 | 역할 | 설명 |
|--------|------|------|
| **Canvas Layer** | 시각적 렌더링 | PDF 콘텐츠를 캔버스에 그림 |
| **Text Layer** | 텍스트 오버레이 | 투명 텍스트 레이어 (선택/검색용) |
| **Annotation Layer** | 인터랙티브 요소 | 링크, 폼, 하이라이트 등 |

## PDF.js 핵심 API

### 문서 로드

```javascript
import * as pdfjsLib from 'pdfjs-dist';

// Worker 설정
pdfjsLib.GlobalWorkerOptions.workerSrc = '/pdf.worker.min.mjs';

// PDF 문서 로드
const loadingTask = pdfjsLib.getDocument(url);
const pdfDoc = await loadingTask.promise;

console.log(`총 페이지: ${pdfDoc.numPages}`);
```

### 페이지 렌더링

```javascript
// 페이지 가져오기
const page = await pdfDoc.getPage(pageNumber);

// 뷰포트 생성 (스케일 조정)
const viewport = page.getViewport({ scale: 1.5 });

// 캔버스 설정
const canvas = document.getElementById('pdf-canvas');
const context = canvas.getContext('2d');
canvas.width = viewport.width;
canvas.height = viewport.height;

// 렌더링
const renderContext = {
  canvasContext: context,
  viewport: viewport,
};
await page.render(renderContext).promise;
```

### 텍스트 레이어 추가

```javascript
// 텍스트 콘텐츠 가져오기
const textContent = await page.getTextContent();

// 텍스트 레이어 렌더링
const textLayer = new pdfjsLib.TextLayer({
  textContentSource: textContent,
  container: textLayerDiv,
  viewport: viewport,
});
await textLayer.render();
```

### 주석 레이어

```javascript
// 주석 가져오기
const annotations = await page.getAnnotations();

// 주석 처리
annotations.forEach(annotation => {
  console.log(annotation.subtype); // Link, Widget, Text, etc.
  console.log(annotation.rect);    // [x1, y1, x2, y2]
});
```

## PDF.js 뷰어 URL 파라미터

| 파라미터 | 설명 | 값 |
|----------|------|-----|
| `file` | PDF 파일 경로 | URL 인코딩된 경로 |
| `page` | 시작 페이지 번호 | 숫자 |
| `zoom` | 확대/축소 수준 | 숫자, `page-width`, `page-height`, `page-fit`, `auto` |
| `pagemode` | 사이드바 상태 | `none`, `thumbs`, `bookmarks`, `attachments` |
| `nameddest` | 명명된 목적지 | 목적지 이름 |

**사용 예시**:
```
viewer.html?file=document.pdf&page=3&zoom=page-width&pagemode=thumbs
```

## PDF.js 내장 주석 편집기

| 유형 | 설명 |
|------|------|
| **FreeText** | 텍스트 주석 추가 |
| **Highlight** | 텍스트 하이라이트 |
| **Stamp** | 이미지 스탬프 추가 |
| **Ink** | 자유 드로잉 |

## PDF.js 뷰어 단축키

| 동작 | 단축키 |
|------|--------|
| 다음 페이지 | `N`, `J` |
| 이전 페이지 | `P`, `K` |
| 사이드바 토글 | `F4` |
| 확대 | `Ctrl/Cmd + +` |
| 축소 | `Ctrl/Cmd + -` |
| 찾기 | `Ctrl/Cmd + F` |
| 프레젠테이션 다음 | `Space`, `Enter` |
| 프레젠테이션 이전 | `Shift + Space`, `Shift + Enter` |

## 웹 뷰어 성능 최적화 Best Practices

### 로딩 최적화
- **스트리밍**: 대용량 파일 스트리밍 로드
- **지연 렌더링**: 화면 밖 페이지는 렌더링 지연
- **Web Worker**: PDF 파싱을 별도 워커 스레드에서 처리
- **페이지 캐싱**: 렌더링된 페이지 캐시로 스크롤 성능 향상

### 렌더링 최적화
- **프로그레시브 로딩**: 전체 문서 대신 페이지 단위 로드
- **해상도 조정**: 디바이스 DPI에 맞는 적절한 스케일 사용
- **가시 영역 우선**: 현재 보이는 페이지만 렌더링

### 보안
- 문서 샌드박싱
- 외부 의존성 제어
- JavaScript 실행 제한

### 반응형 디자인
```css
.pdf-viewer-container {
  width: 100%;
  height: calc(100vh - 60px);
  overflow: auto;
}
```

### 모바일 최적화
- 핀치 줌 터치 제스처 지원
- 스와이프 페이지 이동
- 모바일 브라우저 성능 고려 (대용량 문서 주의)

## 주요 PDF JavaScript 라이브러리 비교

| 라이브러리 | 유형 | 라이선스 | 특징 |
|------------|------|----------|------|
| **PDF.js** | 오픈소스 | Apache 2.0 | Mozilla, 브라우저 기본 뷰어 |
| **Nutrient (PSPDFKit)** | 상용 | 유료 | 완전한 편집 기능, 고성능 |
| **Apryse (PDFTron)** | 상용 | 유료 | 광범위한 주석 기능 |
| **Syncfusion** | 상용 | 유료/커뮤니티 | .NET 생태계 통합 |
| **react-pdf** | 오픈소스 | MIT | React PDF.js 래퍼 |

## PDF.js 제한사항

- 주석 편집기는 HTML 오버레이로 렌더링 (PDF 구조에 임베드 X)
- 다른 PDF 리더에서 주석이 올바르게 표시되지 않을 수 있음
- 대용량 문서에서 모바일 브라우저 성능 이슈
- 데스크탑 도구 대비 제한적인 폼 편집 기능
