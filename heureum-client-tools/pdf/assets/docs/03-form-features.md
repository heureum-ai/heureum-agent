# PDF 폼 필드 및 전자서명 기능

## 폼 필드 유형

| 필드 유형 | 설명 | 예시 |
|-----------|------|------|
| **텍스트 필드 (Text Field)** | 단일/다중 라인 텍스트 입력 | 이름, 주소, 비고 |
| **체크박스 (Check Box)** | 토글 on/off 선택 | 약관 동의, 옵션 선택 |
| **라디오 버튼 (Radio Button)** | 그룹 내 배타적 선택 | 성별, 등급 선택 |
| **드롭다운 (Combo Box)** | 미리 정의된 목록에서 선택 | 국가, 부서 |
| **리스트 박스 (List Box)** | 스크롤 가능한 선택 목록 | 다중 항목 선택 |
| **푸시 버튼 (Push Button)** | 동작 트리거 (제출, 리셋, JS) | 제출 버튼, 초기화 |
| **서명 필드 (Signature Field)** | 디지털/전자 서명 영역 | 계약서 서명란 |
| **날짜 필드 (Date Field)** | 형식 검증이 있는 날짜 입력 | 날짜 선택 |
| **바코드 필드 (Barcode Field)** | 폼 데이터로 바코드 생성 | 자동 바코드 |

## 폼 기능

### 폼 생성 및 관리
- **자동 필드 감지**: 정적 폼에서 자동으로 필드 식별 및 생성
- **탭 순서 (Tab Order)**: 필드 간 이동 순서 설정
- **기본값 (Default Values)**: 필드에 기본 데이터 미리 채우기
- **필수 필드 (Required Fields)**: 필수 입력 필드 표시

### 폼 검증 및 계산
- **필드 검증**: JavaScript 기반 입력값 검증
- **계산 필드**: 다른 필드 값을 기반으로 자동 계산
- **필드 서식**: 숫자, 날짜, 시간, 커스텀 형식

### 폼 데이터 관리
- **가져오기/내보내기**: FDF, XFDF, XML, CSV 형식 지원
- **폼 배포**: 폼 전송 및 응답 수집
- **폼 추적**: 완료 상태 모니터링

## 전자 서명

### 서명 방식

| 방식 | 설명 | 보안 수준 |
|------|------|-----------|
| **타이핑 서명** | 이름을 텍스트로 입력 | 낮음 |
| **드로잉 서명** | 마우스/터치로 직접 작성 | 중간 |
| **이미지 서명** | 서명 이미지 업로드 | 중간 |
| **인증서 기반 디지털 서명** | 인증서로 암호화 서명 | 높음 |
| **클라우드 기반 서명** | Adobe Sign, DocuSign 등 | 높음 |

### 디지털 서명 기술 상세

```
서명 프로세스:
┌─────────────┐    ┌──────────────┐    ┌─────────────┐
│  문서 해시   │ → │ 개인키로 암호화 │ → │  서명 생성   │
│  (SHA-256)  │    │              │    │             │
└─────────────┘    └──────────────┘    └─────────────┘

검증 프로세스:
┌─────────────┐    ┌──────────────┐    ┌─────────────┐
│  서명 추출   │ → │ 공개키로 복호화 │ → │  해시 비교   │
│             │    │              │    │ (무결성 확인) │
└─────────────┘    └──────────────┘    └─────────────┘
```

### 핵심 기술 요소

| 요소 | 설명 |
|------|------|
| **인증서 검증** | 인증서 체인을 통한 서명자 신원 확인 |
| **타임스탬프** | TSA(Time Stamping Authority)를 통한 정확한 서명 시간 기록 |
| **LTV (Long-Term Validation)** | OCSP/CRL 폐기 데이터를 임베드하여 장기 검증 가능 |
| **문서 무결성** | 서명 후 수정 사항 감지 |
| **다중 서명** | 순차적/병렬 서명 워크플로우 지원 |
| **서명 외형** | 서명의 시각적 표현 커스터마이즈 |

## @heureum/pdf에서의 폼 기능

이 프로젝트에서 제공하는 폼 관련 도구:

### 필드 확인 및 추출
```typescript
// 채울 수 있는 폼인지 확인
checkFillableFields(pdfPath)
// → { success: boolean, output: string }

// 폼 필드 정보 추출
getFieldInfo(pdfPath)
// → FieldInfo[] (TextFieldInfo | CheckboxFieldInfo | ChoiceFieldInfo | RadioGroupFieldInfo)

// 폼 필드 정보를 JSON으로 내보내기
extractFormFieldInfo(inputPdfPath, outputJsonPath)
```

### 폼 채우기
```typescript
// 대화형 폼 필드 채우기 (PDF에 내장된 폼 필드가 있는 경우)
fillFillableFields(inputPdfPath, fieldValuesJsonPath, outputPdfPath)

// 주석 기반 채우기 (폼 필드가 없는 비정형 PDF)
fillPdfFormWithAnnotations(inputPdfPath, fieldsJsonPath, outputPdfPath)
```

### 구조 분석
```typescript
// PDF 폼의 시각적 구조 분석 (라벨, 선, 체크박스, 행 경계)
extractFormStructure(inputPdfPath, outputJsonPath)
```

### 지원하는 필드 유형

| 유형 | `fillFillableFields` | `fillPdfFormWithAnnotations` |
|------|:--------------------:|:---------------------------:|
| 텍스트 필드 | O | O (FreeText 주석) |
| 체크박스 | O | - |
| 라디오 그룹 | O | - |
| 드롭다운 | O | - |
| 커스텀 폰트/크기 | - | O |
| 좌표 지정 입력 | - | O |
