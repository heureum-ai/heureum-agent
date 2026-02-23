/**
 * 복잡한 DOCX 문서를 output/ 에 생성하는 스크립트.
 *
 * 1) Markdown 파이프라인 — 기술 보고서
 * 2) 구조화 API(createDocument) — 사업 제안서
 *
 * Usage:  npx tsx scripts/generate-output.ts
 */

import * as fs from 'fs';
import * as path from 'path';
import { createDocx } from '../src/writer.js';
import { createDocument, type DocxCreateDocumentParams } from '../src/create-document.js';

const OUT = path.resolve(new URL('..', import.meta.url).pathname, 'output');
fs.mkdirSync(OUT, { recursive: true });

// ─────────────────────────────────────────────
// 1. Markdown Pipeline → 기술 보고서
// ─────────────────────────────────────────────
async function generateMarkdownDoc() {
  const md = `# 클라우드 네이티브 아키텍처 전환 가이드

## 1. Executive Summary

본 문서는 **레거시 모놀리식 시스템**을 **클라우드 네이티브 마이크로서비스 아키텍처**로 전환하기 위한 기술 가이드입니다.
전환 과정에서의 *핵심 의사결정 포인트*, *리스크 요소*, 그리고 *단계별 실행 로드맵*을 다룹니다.

---

## 2. 현행 시스템 분석

### 2.1 아키텍처 현황

| 구분 | 현행 | 목표 |
|------|------|------|
| 아키텍처 | 모놀리식 3-tier | 마이크로서비스 |
| 배포 주기 | 월 1회 | 일 수회 (CI/CD) |
| 확장 방식 | 수직 확장 (Scale-Up) | 수평 확장 (Scale-Out) |
| 데이터베이스 | Oracle RAC 단일 | 서비스별 독립 DB (Polyglot) |
| 메시징 | MQ 기반 동기 호출 | 이벤트 드리븐 (Kafka) |
| 모니터링 | 서버 레벨 APM | 분산 트레이싱 (Jaeger) |
| 인프라 | On-Premise 물리 서버 | Kubernetes on AWS/GCP |

### 2.2 핵심 문제점

기존 시스템의 주요 한계:

1. **배포 병목**: 단일 코드베이스로 인한 배포 지연 (평균 리드타임 23일)
2. **확장성 제한**: 트래픽 급증 시 전체 시스템 수직 확장만 가능
3. **장애 전파**: 하나의 모듈 장애가 전체 시스템에 영향
4. **기술 부채**: 10년 이상 축적된 레거시 코드 (Java 8, Spring 3.x)
5. **인력 의존성**: 특정 개발자에 대한 높은 지식 집중도

---

## 3. 목표 아키텍처

### 3.1 마이크로서비스 설계 원칙

다음 원칙에 따라 서비스를 분리합니다:

- **단일 책임 원칙 (SRP)**: 각 서비스는 하나의 비즈니스 능력만 담당
- **자율 배포**: 다른 서비스와 독립적으로 배포 가능
- **데이터 소유권**: 각 서비스가 자체 데이터 저장소를 소유
- **API-First**: 모든 서비스 간 통신은 명확한 API 계약으로 정의
- **장애 격리**: Circuit Breaker 패턴으로 장애 전파 차단
- **관찰 가능성**: 로그, 메트릭, 트레이스의 통합 모니터링

### 3.2 서비스 도메인 분해

| 도메인 | 서비스명 | 주요 기능 | 기술 스택 | DB |
|--------|----------|-----------|-----------|-----|
| 사용자 | user-service | 인증, 프로필, 권한 | Spring Boot 3 | PostgreSQL |
| 주문 | order-service | 주문 생성, 상태 관리 | Spring Boot 3 | PostgreSQL |
| 결제 | payment-service | PG 연동, 정산 | Kotlin + Ktor | PostgreSQL |
| 상품 | product-service | 카탈로그, 재고 | Node.js + NestJS | MongoDB |
| 알림 | notification-service | 이메일, 푸시, SMS | Go + Gin | Redis |
| 검색 | search-service | 전문 검색, 추천 | Python + FastAPI | Elasticsearch |
| 분석 | analytics-service | 실시간 대시보드 | Scala + Akka | ClickHouse |

### 3.3 인프라 아키텍처

| 계층 | 구성 요소 | 역할 |
|------|-----------|------|
| CDN | CloudFront | 정적 자산 캐싱, 글로벌 배포 |
| Gateway | Kong / AWS ALB | Rate Limiting, 인증, 라우팅 |
| 서비스 (K8s) | user-svc, order-svc, payment-svc | 비즈니스 로직 처리 |
| 데이터 | PostgreSQL (서비스별 독립) | 서비스 전용 데이터 저장 |
| 이벤트 | Apache Kafka | 비동기 이벤트 스트리밍 |
| 모니터링 | Prometheus + Grafana + Jaeger | 메트릭, 대시보드, 분산 트레이싱 |

**트래픽 흐름:** CloudFront → API Gateway → Kubernetes 서비스 → 개별 DB / Kafka 이벤트 버스

---

## 4. 마이그레이션 로드맵

### Phase 1: Foundation (Q1)

- Kubernetes 클러스터 구축 및 CI/CD 파이프라인 설정
- API Gateway 도입 및 인증 체계 통합
- 모니터링 인프라 구축 (Prometheus + Grafana + Jaeger)
- 공통 라이브러리 개발 (로깅, 설정, 에러 처리)

### Phase 2: Pilot Migration (Q2)

- **user-service** 분리 (인증/인가 독립)
- **notification-service** 신규 개발
- Strangler Fig 패턴으로 점진적 트래픽 전환
- E2E 테스트 자동화 구축

### Phase 3: Core Domain (Q3)

- **order-service**, **payment-service** 분리
- 이벤트 소싱 + CQRS 패턴 적용
- Saga 패턴으로 분산 트랜잭션 관리
- 카나리 배포 전략 도입

### Phase 4: Full Migration (Q4)

- 나머지 서비스 전체 마이그레이션
- 레거시 시스템 완전 종료
- 성능 최적화 및 비용 튜닝
- 운영 프로세스 재정립

---

## 5. 리스크 관리

| 리스크 | 영향도 | 발생 확률 | 대응 방안 |
|--------|--------|-----------|-----------|
| 데이터 정합성 이슈 | 높음 | 중간 | Saga 패턴 + 보상 트랜잭션 |
| 서비스 간 통신 장애 | 높음 | 높음 | Circuit Breaker + Retry + Fallback |
| 운영 복잡도 증가 | 중간 | 높음 | GitOps + IaC + 표준 운영 매뉴얼 |
| 팀 역량 부족 | 높음 | 중간 | 교육 프로그램 + 외부 전문가 코칭 |
| 마이그레이션 일정 지연 | 중간 | 중간 | 버퍼 기간 확보 + MVP 우선 접근 |
| 보안 취약점 노출 | 높음 | 낮음 | 제로 트러스트 + 자동 보안 스캔 |

---

## 6. 예상 효과

> 마이크로서비스 전환을 통해 배포 주기를 **월 1회에서 일 수회**로 단축하고,
> 시스템 가용성을 **99.9%에서 99.99%**로 향상시킬 수 있습니다.
> 인프라 비용은 탄력적 확장을 통해 **연간 30% 절감**이 예상됩니다.

---

*본 문서는 기술 검토 목적으로 작성되었으며, 실제 구현 시 상세 설계 문서가 별도로 작성됩니다.*
`;

  const buf = await createDocx(md, {
    title: '클라우드 네이티브 아키텍처 전환 가이드',
    fontName: 'Malgun Gothic',
  });

  const outPath = path.join(OUT, '01-cloud-native-guide.docx');
  fs.writeFileSync(outPath, buf);
  console.log(`✓ ${path.basename(outPath)}  (${(buf.length / 1024).toFixed(1)} KB)`);
}

// ─────────────────────────────────────────────
// 2. 구조화 API → 사업 제안서
// ─────────────────────────────────────────────
async function generateStructuredDoc() {
  const params: DocxCreateDocumentParams = {
    output_path: path.join(OUT, '02-business-proposal.docx'),
    title: 'AI 기반 스마트 팩토리 구축 사업 제안서',
    page_size: 'a4',
    font: 'Malgun Gothic',
    font_size: 11,
    margin: { top: 25, bottom: 20, left: 25, right: 25 },
    header: 'AI 스마트 팩토리 제안서  |  Heureum Inc.  |  Confidential',
    footer: '© 2024 Heureum Inc. — 본 문서의 무단 복제 및 배포를 금합니다.',
    content: [
      // ── 표지 ──
      { paragraph: { text: '', lineSpacing: 400 } },
      { paragraph: { text: 'Heureum Inc.', fontSize: 14, alignment: 'CENTER', color: '#2E5090' } },
      { paragraph: { text: '', lineSpacing: 100 } },
      { paragraph: { text: 'AI 기반', fontSize: 22, alignment: 'CENTER', color: '#333333' } },
      { paragraph: { text: '스마트 팩토리 구축', heading: 1, alignment: 'CENTER', fontSize: 32 } },
      { paragraph: { text: '사업 제안서', fontSize: 22, alignment: 'CENTER', color: '#333333' } },
      { paragraph: { text: '', lineSpacing: 300 } },
      {
        table: {
          rows: [
            ['제안사', 'Heureum Inc.'],
            ['제안일', '2024년 3월 15일'],
            ['제안 대상', '한국제조공업 주식회사'],
            ['문서 번호', 'PROP-2024-SF-003'],
            ['보안 등급', '대외비'],
            ['유효기간', '제출일로부터 90일'],
          ],
          columnWidths: [40, 110],
          headerRow: false,
        },
      },

      // ── 목차 ──
      { pageBreak: true },
      { paragraph: { text: '목 차', heading: 1, alignment: 'CENTER' } },
      { paragraph: { text: '' } },
      { paragraph: { text: '1. 회사 소개 ................................................ 3', marginLeft: 10 } },
      { paragraph: { text: '2. 제안 배경 및 목적 ........................................ 4', marginLeft: 10 } },
      { paragraph: { text: '3. 현황 분석 ................................................ 5', marginLeft: 10 } },
      { paragraph: { text: '4. 솔루션 제안 .............................................. 7', marginLeft: 10 } },
      { paragraph: { text: '   4.1 시스템 아키텍처 ...................................... 7', marginLeft: 15 } },
      { paragraph: { text: '   4.2 AI 모델 구성 ......................................... 8', marginLeft: 15 } },
      { paragraph: { text: '   4.3 데이터 파이프라인 .................................... 9', marginLeft: 15 } },
      { paragraph: { text: '5. 추진 일정 ................................................ 10', marginLeft: 10 } },
      { paragraph: { text: '6. 투자 비용 ................................................ 11', marginLeft: 10 } },
      { paragraph: { text: '7. 기대 효과 ................................................ 12', marginLeft: 10 } },
      { paragraph: { text: '8. 프로젝트 조직 ............................................ 13', marginLeft: 10 } },

      // ── 1. 회사 소개 ──
      { pageBreak: true },
      { paragraph: { text: '1. 회사 소개', heading: 1 } },
      { paragraph: { text: '' } },
      {
        paragraph: {
          runs: [
            { text: 'Heureum Inc.', bold: true, fontSize: 13, color: '#2E5090' },
            { text: '는 2019년 설립된 AI 전문 기업으로, 제조·물류·금융 산업에 특화된 AI 솔루션을 제공합니다. ' },
            { text: '현재까지 ', italic: true },
            { text: '47개 기업', bold: true },
            { text: '에 AI 솔루션을 공급하였으며, 평균 고객 만족도 ', italic: true },
            { text: '4.7/5.0', bold: true, color: '#D4380D' },
            { text: '을 유지하고 있습니다.' },
          ],
        },
      },
      { paragraph: { text: '' } },
      {
        table: {
          rows: [
            ['구분', '내용'],
            ['설립일', '2019년 6월'],
            ['대표이사', '김 AI'],
            ['직원 수', '182명 (AI 엔지니어 87명)'],
            ['매출액', '2023년 기준 285억원'],
            ['주요 인증', 'ISO 27001, ISO 9001, ISMS-P'],
            ['R&D 비중', '매출 대비 28%'],
          ],
          headerRow: true,
          headerBackground: '#2E5090',
          columnWidths: [40, 110],
        },
      },
      { paragraph: { text: '' } },
      { paragraph: { text: '주요 레퍼런스:', bold: true } },
      { paragraph: { text: '삼성전자 반도체 사업부 — AI 기반 불량 검출 시스템 (2023)', bullet: true } },
      { paragraph: { text: 'LG화학 — 공정 최적화 AI 플랫폼 (2023)', bullet: true } },
      { paragraph: { text: '현대자동차 — 예지 정비 AI 솔루션 (2022)', bullet: true } },
      { paragraph: { text: 'SK하이닉스 — 수율 예측 모델 (2022)', bullet: true } },
      { paragraph: { text: 'POSCO — 에너지 효율 최적화 (2021)', bullet: true } },

      // ── 2. 제안 배경 ──
      { pageBreak: true },
      { paragraph: { text: '2. 제안 배경 및 목적', heading: 1 } },
      { paragraph: { text: '' } },
      {
        paragraph: {
          text: '글로벌 제조업은 Industry 4.0의 가속화와 함께 디지털 전환(DX)이 생존의 필수 요소가 되었습니다. ' +
            '특히 AI/ML 기술의 급속한 발전으로, 제조 현장의 데이터를 실시간으로 분석하여 ' +
            '불량률 감소, 에너지 절감, 설비 가동률 향상 등을 달성하는 스마트 팩토리가 주목받고 있습니다.',
        },
      },
      { paragraph: { text: '' } },
      {
        paragraph: {
          runs: [
            { text: '한국제조공업(주)', bold: true },
            { text: '의 현 생산 라인은 연간 ' },
            { text: '불량률 2.8%', bold: true, color: '#D4380D' },
            { text: ', ' },
            { text: '비계획 정지율 5.2%', bold: true, color: '#D4380D' },
            { text: '로, 업계 평균 대비 높은 수준입니다. 본 제안은 AI 기반 스마트 팩토리 솔루션을 통해 ' },
            { text: '불량률 0.5% 이하, 비계획 정지율 1.0% 이하', bold: true, color: '#2E7D32' },
            { text: '를 목표로 합니다.' },
          ],
        },
      },
      { paragraph: { text: '' } },
      { paragraph: { text: '제안 목적:', bold: true, fontSize: 12 } },
      { paragraph: { text: 'AI 비전 검사를 통한 실시간 불량 검출 및 분류 자동화', numbered: true } },
      { paragraph: { text: '설비 센서 데이터 기반 예지 정비(Predictive Maintenance) 시스템 구축', numbered: true } },
      { paragraph: { text: '공정 파라미터 최적화를 통한 에너지 소비 절감', numbered: true } },
      { paragraph: { text: '실시간 생산 현황 모니터링 대시보드 구축', numbered: true } },
      { paragraph: { text: '데이터 기반 의사결정 지원 체계 확립', numbered: true } },

      // ── 3. 현황 분석 ──
      { pageBreak: true },
      { paragraph: { text: '3. 현황 분석', heading: 1 } },
      { paragraph: { text: '' } },
      { paragraph: { text: '3.1 생산 라인 현황', heading: 2 } },
      { paragraph: { text: '' } },
      {
        table: {
          rows: [
            ['라인', '제품군', '일 생산량', '불량률', '가동률', '인원'],
            ['Line A', 'PCB 기판', '12,000개', '3.2%', '87%', '45명'],
            ['Line B', '커넥터', '28,000개', '2.1%', '91%', '32명'],
            ['Line C', '센서 모듈', '8,500개', '3.8%', '83%', '38명'],
            ['Line D', '전장 부품', '15,000개', '2.3%', '89%', '41명'],
          ],
          headerRow: true,
          headerBackground: '#37474F',
          columnWidths: [18, 25, 25, 18, 18, 18],
        },
      },
      { paragraph: { text: '' } },
      { paragraph: { text: '3.2 주요 손실 분석', heading: 2 } },
      { paragraph: { text: '' } },
      {
        table: {
          rows: [
            ['손실 유형', '연간 손실액', '비중', '주요 원인'],
            ['불량 폐기', '42억원', '35%', '육안 검사 한계, 미세 결함 누락'],
            ['비계획 정지', '38억원', '32%', '설비 노후, 예방 정비 부재'],
            ['에너지 낭비', '22억원', '18%', '비효율 공정 파라미터'],
            ['과잉 재고', '11억원', '9%', '수요 예측 부정확'],
            ['기타', '7억원', '6%', '인력 교대 비효율 등'],
          ],
          headerRow: true,
          headerBackground: '#B71C1C',
          columnWidths: [30, 25, 15, 80],
        },
      },
      { paragraph: { text: '' } },
      {
        paragraph: {
          runs: [
            { text: '연간 총 손실액: ', fontSize: 13 },
            { text: '약 120억원', bold: true, fontSize: 15, color: '#D4380D' },
          ],
        },
      },

      // ── 4. 솔루션 제안 ──
      { pageBreak: true },
      { paragraph: { text: '4. 솔루션 제안', heading: 1 } },
      { paragraph: { text: '' } },
      { paragraph: { text: '4.1 시스템 아키텍처', heading: 2 } },
      { paragraph: { text: '' } },
      {
        paragraph: {
          text: '제안 솔루션은 Edge-Cloud 하이브리드 아키텍처로 설계됩니다. ' +
            '생산 현장의 Edge 디바이스에서 실시간 추론을 수행하고, 클라우드에서 모델 학습과 대시보드를 운영합니다.',
        },
      },
      { paragraph: { text: '' } },
      {
        table: {
          rows: [
            ['계층', '구성 요소', '역할', '기술'],
            ['Edge Layer', 'NVIDIA Jetson AGX Orin', '실시간 비전 추론', 'TensorRT, ONNX'],
            ['Edge Layer', '산업용 IoT 게이트웨이', '센서 데이터 수집', 'MQTT, OPC-UA'],
            ['Network', '5G 사설망 + Wi-Fi 6', '초저지연 데이터 전송', '<10ms latency'],
            ['Platform', 'Kubernetes (On-Prem)', '서비스 오케스트레이션', 'K3s, Helm'],
            ['Platform', 'Apache Kafka', '이벤트 스트리밍', 'Kafka Streams'],
            ['Cloud', 'AWS SageMaker', '모델 학습/재학습', 'PyTorch, MLflow'],
            ['Cloud', 'Grafana + InfluxDB', '모니터링 대시보드', 'InfluxQL'],
          ],
          headerRow: true,
          headerBackground: '#1565C0',
          columnWidths: [25, 40, 35, 40],
        },
      },
      { paragraph: { text: '' } },
      { paragraph: { text: '4.2 AI 모델 구성', heading: 2 } },
      { paragraph: { text: '' } },
      {
        table: {
          rows: [
            ['모델', '목적', '알고리즘', '정확도 목표', '추론 속도'],
            ['Vision Inspector', '외관 불량 검출', 'YOLOv8 + EfficientNet', '≥99.5%', '<50ms'],
            ['Anomaly Detector', '설비 이상 탐지', 'Transformer Autoencoder', '≥97%', '<100ms'],
            ['Energy Optimizer', '공정 파라미터 최적화', 'Bayesian Optimization', '에너지 15%↓', '실시간'],
            ['Demand Forecaster', '수요/재고 예측', 'TFT (Temporal Fusion)', 'MAPE <5%', '배치'],
            ['Root Cause Analyzer', '불량 원인 분석', 'GNN + Causal Inference', 'Top-3 정확도 90%', '<1s'],
          ],
          headerRow: true,
          headerBackground: '#4A148C',
          columnWidths: [35, 30, 40, 25, 20],
        },
      },

      // ── 5. 추진 일정 ──
      { pageBreak: true },
      { paragraph: { text: '5. 추진 일정', heading: 1 } },
      { paragraph: { text: '' } },
      {
        table: {
          rows: [
            ['단계', '기간', '주요 활동', '산출물', '마일스톤'],
            ['1단계: 분석', '2024.04 ~ 05\n(8주)', '현장 진단, 데이터 수집\n요구사항 분석, PoC 설계', '분석 보고서\nPoC 계획서', 'Kick-off'],
            ['2단계: PoC', '2024.06 ~ 08\n(12주)', 'Line A 파일럿 구축\nAI 모델 프로토타입 개발', 'PoC 결과 보고서\n모델 성능 리포트', 'PoC 완료'],
            ['3단계: 구축', '2024.09 ~ 2025.02\n(24주)', '전체 라인 확대 구축\n시스템 통합, 최적화', '시스템 구축 완료\n운영 매뉴얼', '시스템 오픈'],
            ['4단계: 안정화', '2025.03 ~ 05\n(12주)', '안정화, 성능 튜닝\n운영 이관, 교육', '최종 완료 보고서\n교육 수료 확인', '프로젝트 종료'],
          ],
          headerRow: true,
          headerBackground: '#006064',
          columnWidths: [25, 30, 40, 30, 25],
        },
      },
      { paragraph: { text: '' } },
      {
        paragraph: {
          runs: [
            { text: '총 사업 기간: ' },
            { text: '14개월', bold: true, fontSize: 14, color: '#1565C0' },
            { text: ' (2024년 4월 ~ 2025년 5월)' },
          ],
        },
      },

      // ── 6. 투자 비용 ──
      { pageBreak: true },
      { paragraph: { text: '6. 투자 비용', heading: 1 } },
      { paragraph: { text: '' } },
      {
        table: {
          rows: [
            ['항목', '상세', '수량', '단가 (만원)', '소계 (만원)'],
            ['H/W', 'NVIDIA Jetson AGX Orin', '20대', '350', '7,000'],
            ['H/W', 'IoT 센서 및 게이트웨이', '120식', '50', '6,000'],
            ['H/W', 'GPU 서버 (A100 x4)', '2대', '8,000', '16,000'],
            ['S/W', 'AI 플랫폼 라이선스', '1식', '15,000', '15,000'],
            ['S/W', '대시보드 시스템 개발', '1식', '8,000', '8,000'],
            ['인건비', 'AI 엔지니어 (8명 × 14개월)', '112M/M', '800', '89,600'],
            ['인건비', 'PM/PL (2명 × 14개월)', '28M/M', '900', '25,200'],
            ['인건비', '인프라 엔지니어 (3명 × 10개월)', '30M/M', '750', '22,500'],
            ['기타', '출장/교육/예비비', '1식', '5,000', '5,000'],
          ],
          headerRow: true,
          headerBackground: '#33691E',
          columnWidths: [20, 45, 18, 25, 25],
        },
      },
      { paragraph: { text: '' } },
      {
        paragraph: {
          runs: [
            { text: '총 투자 비용: ', fontSize: 14 },
            { text: '194,300만원 (약 19.4억원)', bold: true, fontSize: 16, color: '#1565C0' },
            { text: '  (VAT 별도)', fontSize: 10, color: '#999999' },
          ],
        },
      },

      // ── 7. 기대 효과 ──
      { pageBreak: true },
      { paragraph: { text: '7. 기대 효과', heading: 1 } },
      { paragraph: { text: '' } },
      {
        table: {
          rows: [
            ['효과 항목', '현재', '목표', '개선율', '연간 절감액'],
            ['불량률', '2.8%', '0.5%', '82% ↓', '35억원'],
            ['비계획 정지율', '5.2%', '1.0%', '81% ↓', '31억원'],
            ['에너지 비용', '100%', '85%', '15% ↓', '17억원'],
            ['재고 비용', '100%', '80%', '20% ↓', '9억원'],
            ['검사 인력', '24명', '8명', '67% ↓', '12억원'],
          ],
          headerRow: true,
          headerBackground: '#1B5E20',
          columnWidths: [30, 20, 20, 20, 25],
        },
      },
      { paragraph: { text: '' } },
      {
        paragraph: {
          runs: [
            { text: '연간 총 절감 효과: ', fontSize: 14 },
            { text: '약 104억원', bold: true, fontSize: 18, color: '#2E7D32' },
          ],
        },
      },
      { paragraph: { text: '' } },
      {
        paragraph: {
          runs: [
            { text: 'ROI (투자 대비 수익률): ', fontSize: 13 },
            { text: '투자 회수 기간 약 2.2년, 5년 ROI 435%', bold: true, fontSize: 13, color: '#1565C0' },
          ],
        },
      },

      // ── 8. 프로젝트 조직 ──
      { pageBreak: true },
      { paragraph: { text: '8. 프로젝트 조직', heading: 1 } },
      { paragraph: { text: '' } },
      {
        table: {
          rows: [
            ['역할', '인원', '담당자', '주요 업무'],
            ['PM (프로젝트 매니저)', '1명', 'Heureum', '전체 프로젝트 관리, 이해관계자 커뮤니케이션'],
            ['PL (프로젝트 리더)', '1명', 'Heureum', '기술 아키텍처 설계, 기술 의사결정'],
            ['AI 엔지니어', '5명', 'Heureum', 'AI 모델 개발, 학습, 최적화'],
            ['데이터 엔지니어', '3명', 'Heureum', '데이터 파이프라인, ETL, 인프라'],
            ['현장 엔지니어', '2명', '공동', '설비 연동, 센서 설치, 현장 지원'],
            ['QA 엔지니어', '1명', 'Heureum', '테스트 자동화, 품질 관리'],
            ['고객측 PM', '1명', '한국제조공업', '요구사항 확인, 내부 조율'],
            ['고객측 현장 담당', '3명', '한국제조공업', '현장 데이터 제공, 도메인 자문'],
          ],
          headerRow: true,
          headerBackground: '#4E342E',
          columnWidths: [40, 15, 30, 65],
        },
      },
      { paragraph: { text: '' } },
      { paragraph: { text: '' } },

      // ── 마무리 ──
      {
        paragraph: {
          runs: [
            { text: 'Heureum Inc.', bold: true, color: '#2E5090' },
            { text: '는 검증된 AI 기술력과 풍부한 제조 도메인 경험을 바탕으로, ' },
            { text: '한국제조공업(주)', bold: true },
            { text: '의 스마트 팩토리 전환을 성공적으로 수행하겠습니다.' },
          ],
        },
      },
      { paragraph: { text: '' } },
      {
        paragraph: {
          text: '감사합니다.',
          alignment: 'CENTER',
          fontSize: 14,
          bold: true,
        },
      },
      { paragraph: { text: '' } },
      { paragraph: { text: '' } },
      {
        paragraph: {
          text: '본 제안서에 포함된 모든 정보는 Heureum Inc.의 영업 비밀에 해당하며, ' +
            '사전 서면 동의 없이 제3자에게 공개하거나 복제할 수 없습니다.',
          fontSize: 9,
          color: '#999999',
          italic: true,
          alignment: 'CENTER',
        },
      },
    ],
  };

  const buffer = await createDocument(params);
  fs.writeFileSync(params.output_path, buffer);
  console.log(`✓ ${path.basename(params.output_path)}  (${(buffer.length / 1024).toFixed(1)} KB)`);
}

// ─────────────────────────────────────────────
// 3. Markdown Pipeline → 학술 논문 스타일
// ─────────────────────────────────────────────
async function generateAcademicDoc() {
  const md = `# 대규모 언어 모델의 한국어 성능 평가: 벤치마크 및 실증 분석

## Abstract

본 연구는 주요 대규모 언어 모델(LLM)의 한국어 처리 능력을 체계적으로 평가합니다.
**GPT-4**, **Claude 3**, **Gemini Pro**, **HyperCLOVA X** 등 8개 모델을 대상으로,
*자연어 이해(NLU)*, *자연어 생성(NLG)*, *추론(Reasoning)*, *안전성(Safety)* 4개 축에서
총 **12개 벤치마크, 4,800개 테스트 케이스**로 평가를 수행했습니다.

---

## 1. 서론

한국어는 교착어적 특성, 경어법, 한자어 혼용 등으로 인해 영어 기반 LLM에서 상대적으로 낮은 성능을 보이는 것으로 알려져 있습니다. 그러나 2024년에 출시된 최신 모델들은 다국어 학습 데이터의 확대와 새로운 토크나이저 설계를 통해 한국어 성능이 크게 향상되었습니다.

본 연구의 기여는 다음과 같습니다:

1. **종합적 벤치마크 프레임워크**: 한국어 특성을 반영한 4축 12개 벤치마크 체계 설계
2. **대규모 실증 평가**: 8개 모델 × 4,800 케이스의 정량적 비교
3. **오류 유형 분석**: 모델별 한국어 특화 오류 패턴 식별
4. **실용적 가이드라인**: 용도별 최적 모델 선택 기준 제시

---

## 2. 관련 연구

### 2.1 LLM 평가 방법론

| 벤치마크 | 대상 언어 | 평가 영역 | 문제 수 | 비고 |
|----------|-----------|-----------|---------|------|
| MMLU | 영어 | 지식/추론 | 15,908 | 57개 과목 |
| HellaSwag | 영어 | 상식 추론 | 10,042 | 문장 완성 |
| KoBEST | 한국어 | NLU 종합 | 5,200 | 5개 태스크 |
| KLUE | 한국어 | NLU | 11,300 | 8개 태스크 |
| KorQuAD | 한국어 | 독해 | 60,407 | MRC |
| HAE-RAE | 한국어 | 문화·역사 | 1,500 | 한국 특화 |
| KoMT-Bench | 한국어 | 대화 품질 | 160 | GPT-4 심사 |

### 2.2 한국어 토크나이저 분석

한국어 처리에서 토크나이저의 효율성은 모델 성능에 직접적인 영향을 미칩니다.

- **BPE 기반**: GPT-4, Llama 계열 — 한국어 토큰당 평균 1.2 음절
- **SentencePiece**: T5, mBART 계열 — 한국어 토큰당 평균 1.8 음절
- **형태소 기반**: HyperCLOVA X — 한국어 토큰당 평균 2.3 음절
- **음절 단위**: EEVE, KoAlpaca — 한국어 토큰당 평균 1.0 음절

> 토큰 효율이 높을수록 같은 컨텍스트 윈도우 내에서 더 많은 한국어 텍스트를 처리할 수 있으며,
> 이는 특히 긴 문서 요약이나 RAG 파이프라인에서 실질적인 성능 차이로 이어집니다.

---

## 3. 실험 설계

### 3.1 평가 대상 모델

| 모델 | 개발사 | 파라미터 | 한국어 학습 비중 | 컨텍스트 | API 가격 |
|------|--------|----------|-----------------|----------|----------|
| GPT-4 Turbo | OpenAI | ~1.8T | ~3% | 128K | $10/1M |
| Claude 3 Opus | Anthropic | 비공개 | ~5% | 200K | $15/1M |
| Gemini Ultra | Google | 비공개 | ~4% | 1M | $7/1M |
| HyperCLOVA X | NAVER | 비공개 | ~40% | 32K | ₩3/1K |
| Llama 3 70B | Meta | 70B | ~2% | 8K | 오픈소스 |
| Qwen 72B | Alibaba | 72B | ~8% | 32K | 오픈소스 |
| EEVE 10.8B | Upstage | 10.8B | ~30% | 4K | 오픈소스 |
| SOLAR 10.7B | Upstage | 10.7B | ~25% | 4K | 오픈소스 |

### 3.2 평가 체계

**축 1: 자연어 이해 (NLU)**

- 감성 분석: NSMC (영화 리뷰 2,000건)
- 자연어 추론: KorNLI (전제-가설 쌍 500건)
- 의미 유사도: KorSTS (문장 쌍 400건)

**축 2: 자연어 생성 (NLG)**

- 문서 요약: AI Hub 뉴스 데이터 (300건)
- 번역 품질: WMT Ko-En (500건, BLEU/COMET)
- 자유 생성: 에세이·이메일·보고서 (200건, GPT-4 심사)

**축 3: 추론 (Reasoning)**

- 수학: KorMATH (300건, 초등~대학)
- 논리: KorLogic (200건, 연역/귀납/유추)
- 상식: HAE-RAE 문화·역사 (400건)

**축 4: 안전성 (Safety)**

- 유해 콘텐츠 거부율 (300건)
- 편향성 검사 (200건, 성별/지역/세대)

---

## 4. 실험 결과

### 4.1 종합 순위

| 순위 | 모델 | NLU | NLG | 추론 | 안전성 | 종합 |
|------|------|-----|-----|------|--------|------|
| 1 | HyperCLOVA X | 91.2 | 88.7 | 82.4 | 93.1 | 88.9 |
| 2 | Claude 3 Opus | 90.8 | 90.3 | 86.1 | 91.5 | 89.7 |
| 3 | GPT-4 Turbo | 89.5 | 89.1 | 87.3 | 88.2 | 88.5 |
| 4 | Gemini Ultra | 87.3 | 86.5 | 84.7 | 89.8 | 87.1 |
| 5 | Qwen 72B | 84.1 | 82.3 | 78.5 | 85.2 | 82.5 |
| 6 | Llama 3 70B | 82.7 | 80.1 | 80.2 | 82.3 | 81.3 |
| 7 | EEVE 10.8B | 79.5 | 75.8 | 68.3 | 80.1 | 75.9 |
| 8 | SOLAR 10.7B | 78.2 | 74.5 | 67.1 | 78.8 | 74.7 |

### 4.2 주요 발견

1. **한국어 특화 모델의 NLU 우위**: HyperCLOVA X는 NLU에서 최고 성능 달성
2. **범용 모델의 추론 강점**: GPT-4 Turbo가 수학/논리 추론에서 최고 점수
3. **소형 모델의 한계**: 10B급 모델은 종합 점수에서 20% 이상 격차
4. **안전성-성능 트레이드오프**: Claude 3가 안전성과 성능의 균형이 가장 우수
5. **토큰 효율의 영향**: 한국어 토큰 효율이 높은 모델이 긴 문서 처리에서 유리

---

## 5. 결론

본 연구를 통해 한국어 LLM 평가의 종합적 프레임워크를 제시하였습니다.
주요 시사점은 다음과 같습니다:

- 한국어에 특화된 학습 데이터와 토크나이저가 NLU 성능에 결정적
- 추론 능력은 모델 크기와 학습 방법론에 더 크게 좌우됨
- 실무 적용 시 *용도*, *비용*, *보안 요구사항*을 종합적으로 고려하여 모델 선택 필요
- 10B급 오픈소스 모델은 특정 도메인 미세조정을 통해 활용 가능

> 향후 연구에서는 **RAG 파이프라인 통합 평가**, **멀티턴 대화 일관성 분석**,
> 그리고 **한국어 도메인별 세분화 벤치마크** 개발을 계획하고 있습니다.

---

*본 논문은 2024 한국정보과학회 학술대회에 제출된 원고입니다.*
`;

  const buf = await createDocx(md, {
    title: '대규모 언어 모델의 한국어 성능 평가',
    fontName: 'Malgun Gothic',
    fontSizePt: 11,
  });

  const outPath = path.join(OUT, '03-korean-llm-evaluation.docx');
  fs.writeFileSync(outPath, buf);
  console.log(`✓ ${path.basename(outPath)}  (${(buf.length / 1024).toFixed(1)} KB)`);
}

// ─────────────────────────────────────────────
// main
// ─────────────────────────────────────────────
async function main() {
  console.log('=== DOCX 문서 생성 → output/ ===\n');

  await generateMarkdownDoc();
  await generateStructuredDoc();
  await generateAcademicDoc();

  console.log(`\n완료. output/ 폴더를 확인하세요.`);
}

main().catch((err) => {
  console.error('Error:', err);
  process.exit(1);
});
