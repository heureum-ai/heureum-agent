# PDF 실무 가이드 문서

PDF 기능, 단축키, 워크플로우에 대한 종합 실무 가이드입니다.

## 문서 목록

| 문서 | 설명 |
|------|------|
| [01-keyboard-shortcuts.md](./01-keyboard-shortcuts.md) | PDF 뷰어/에디터 단축키 총정리 |
| [02-annotation-markup.md](./02-annotation-markup.md) | 주석 및 마크업 기능 가이드 |
| [03-form-features.md](./03-form-features.md) | 폼 필드 및 전자서명 기능 |
| [04-manipulation.md](./04-manipulation.md) | PDF 조작 기능 (병합, 분할, 압축 등) |
| [05-security.md](./05-security.md) | 보안 기능 (암호화, 권한, 편집) |
| [06-accessibility.md](./06-accessibility.md) | 접근성 기능 및 표준 |
| [07-web-viewer.md](./07-web-viewer.md) | 웹 PDF 뷰어 및 PDF.js 가이드 |
| [08-enterprise-workflows.md](./08-enterprise-workflows.md) | 기업 실무 워크플로우 |

## 주요 PDF 도구 비교

| 도구 | 유형 | 특징 |
|------|------|------|
| Adobe Acrobat Pro | 데스크탑 | 업계 표준, 전체 기능 |
| Foxit PDF Editor | 데스크탑 | 가볍고 빠름, ConnectedPDF |
| PDF.js | 웹 라이브러리 | 오픈소스, 브라우저 렌더링 |
| 알PDF | 데스크탑 | 한국어 최적화, 무료 |
| PDFsam | 데스크탑 | 오픈소스, 병합/분할 특화 |
| iLovePDF | 웹 서비스 | 온라인 PDF 도구 모음 |

## 이 프로젝트와의 관계

`@heureum/pdf`는 PDF 폼 처리에 특화된 TypeScript 라이브러리로, 아래 8가지 도구를 제공합니다:

1. `pdf_check_fillable_fields` - 채울 수 있는 폼 필드 확인
2. `pdf_extract_form_fields` - 폼 필드 메타데이터 추출
3. `pdf_fill_fields` - 대화형 폼 필드 채우기
4. `pdf_fill_annotations` - 텍스트 주석 추가
5. `pdf_extract_form_structure` - 폼 구조 추출
6. `pdf_check_bounding_boxes` - 바운딩 박스 검증
7. `pdf_create_validation_image` - 검증용 이미지 생성
8. `pdf_convert_to_images` - PDF를 이미지로 변환
