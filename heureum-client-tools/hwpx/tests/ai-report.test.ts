/**
 * 2026 AI Comprehensive Report — 10-page HWPX document
 * Uses pipeline (init → markdown → xml → pack) then all edit tools.
 *
 * Directory structure:
 *   output/pipeline-task/ai-2026/hwpx/report/
 *     output/source.md
 *     output/ast.json
 *     output/hwpx/  (XML files)
 *     output/result.hwpx  (base)
 *     output/final.hwpx   (all edits applied)
 */

import { describe, it, expect, beforeAll } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import {
  hwpxInitTask,
  hwpxWriteMarkdown,
  hwpxWriteXml,
  hwpxPack,
  hwpxSetCharFormat,
  hwpxSetParaFormat,
  hwpxSetPageLayout,
  hwpxEditTableCell,
  hwpxSetMetadata,
  hwpxFindReplace,
  hwpxInsertText,
  hwpxInsertImage,
  hwpxSetHeaderFooter,
  hwpxInsertTable,
  hwpxCreateDocument,
} from '../src/tools.js';

const OUT_DIR = path.resolve(__dirname, '../output');
const WORK_DIR = path.join(OUT_DIR, 'pipeline-task');
const SESSION = 'ai-2026';
const TASK = 'report';
const TASK_DIR = path.join(WORK_DIR, SESSION, 'hwpx', TASK);
const OUTPUT_DIR = path.join(TASK_DIR, 'output');

beforeAll(() => {
  // Clean previous runs
  const taskPath = path.join(WORK_DIR, SESSION);
  if (fs.existsSync(taskPath)) {
    fs.rmSync(taskPath, { recursive: true, force: true });
  }
});

/** Resolve path within output step */
function step(name: string): string {
  return path.join(OUTPUT_DIR, name);
}

/** Create a tiny 1x1 blue PNG for image tests */
function createTestPng(): string {
  const filePath = path.join(OUT_DIR, 'ai-report-image.png');
  if (fs.existsSync(filePath)) return filePath;
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const png = Buffer.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
    0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
    0x08, 0x02, 0x00, 0x00, 0x00, 0x90, 0x77, 0x53,
    0xde, 0x00, 0x00, 0x00, 0x0c, 0x49, 0x44, 0x41,
    0x54, 0x08, 0xd7, 0x63, 0x60, 0x60, 0xf8, 0x0f,
    0x00, 0x00, 0x02, 0x00, 0x01, 0xe2, 0x21, 0xbc,
    0x33, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e,
    0x44, 0xae, 0x42, 0x60, 0x82,
  ]);
  fs.writeFileSync(filePath, png);
  return filePath;
}

// ─── 10-page Markdown content ───────────────────────────

const REPORT_MD = `# 2026 Artificial Intelligence Comprehensive Report

## Executive Summary

The global artificial intelligence market has reached unprecedented levels of growth in 2026, fundamentally transforming industries across the spectrum. This comprehensive report analyzes the current state of AI technology, market dynamics, key players, ethical considerations, and future projections. **AI adoption rates have surged by 340%** compared to 2023, with enterprises allocating an average of *23% of their technology budgets* to AI-related initiatives.

The convergence of advanced hardware, sophisticated algorithms, and abundant data has created a perfect storm for innovation. From healthcare diagnostics achieving **98.7% accuracy** to autonomous vehicles completing *over 50 million miles* of real-world testing, AI is no longer a futuristic concept but a present-day reality reshaping our world.

## 1. Global AI Market Overview

### 1.1 Market Size and Growth

The global AI market is projected to reach **$892.3 billion** by the end of 2026, representing a compound annual growth rate (CAGR) of 38.1% from 2022. This explosive growth is driven by several factors including increased cloud computing adoption, rising demand for intelligent virtual assistants, and the proliferation of AI-powered automation across industries.

| Category | 2024 Market | 2025 Market | 2026 Projected | CAGR |
| --- | --- | --- | --- | --- |
| Machine Learning | $165.2B | $228.4B | $312.7B | 37.5% |
| Natural Language Processing | $89.6B | $134.2B | $198.5B | 48.8% |
| Computer Vision | $72.3B | $98.7B | $138.4B | 38.4% |
| Robotics & Automation | $58.1B | $82.5B | $121.3B | 44.5% |
| Generative AI | $45.8B | $78.9B | $121.4B | 62.8% |
| Total | $431.0B | $622.7B | $892.3B | 38.1% |

### 1.2 Regional Distribution

North America continues to dominate the AI landscape, accounting for **38.2%** of the global market share. However, the Asia-Pacific region is experiencing the fastest growth rate at *45.3% CAGR*, driven primarily by massive investments from China, South Korea, and Japan.

- **North America**: $340.8B (38.2%) — Led by the United States with strong venture capital ecosystem
- **Asia-Pacific**: $285.4B (32.0%) — China alone contributes $178.2B, with rapid government-backed initiatives
- **Europe**: $178.5B (20.0%) — EU AI Act creating regulatory framework driving responsible innovation
- **Rest of World**: $87.6B (9.8%) — Emerging markets showing promising adoption patterns

### 1.3 Investment Landscape

Venture capital investment in AI startups reached **$127.8 billion** in 2025, a 56% increase from the previous year. Corporate AI R&D spending exceeded *$200 billion* globally, with technology giants leading the charge.

| Company | AI R&D Spend (2025) | Key Focus Areas | Employees in AI |
| --- | --- | --- | --- |
| Google/Alphabet | $39.2B | LLM, Cloud AI, DeepMind | 12,500+ |
| Microsoft | $35.8B | Copilot, Azure AI, OpenAI | 11,200+ |
| Meta | $28.5B | Llama, AR/VR AI, Social AI | 8,800+ |
| Amazon | $24.1B | AWS AI, Alexa, Robotics | 9,500+ |
| Apple | $18.7B | On-device AI, Siri, Vision | 7,200+ |

## 2. Technology Breakthroughs

### 2.1 Large Language Models (LLMs)

The evolution of Large Language Models has been the most significant technological development of the decade. Models now exceed **10 trillion parameters**, with multimodal capabilities becoming standard rather than exceptional. Key milestones include:

- Reasoning capabilities matching human expert-level performance on standardized tests
- Real-time multilingual translation with **99.2% accuracy** across 150+ languages
- Code generation achieving *87% first-pass success rate* on complex programming tasks
- Long-context windows exceeding **2 million tokens**, enabling entire codebase understanding

### 2.2 AI Agents and Autonomous Systems

Autonomous AI agents capable of planning, executing, and iterating on complex multi-step tasks have emerged as a transformative paradigm. These systems demonstrate remarkable capabilities in software engineering, scientific research, and business process automation.

The agent framework ecosystem has matured significantly, with standardized protocols enabling interoperability between different AI systems. **Model Context Protocol (MCP)** has become the de facto standard for tool integration, allowing AI agents to seamlessly interact with external services and data sources.

### 2.3 Multimodal AI

The boundaries between text, image, audio, and video processing have effectively dissolved. Modern AI systems process and generate content across all modalities simultaneously, enabling:

- Video generation from text descriptions at **4K resolution, 60fps**
- Real-time audio translation preserving speaker voice characteristics
- 3D world modeling from single photographs
- Cross-modal reasoning integrating visual, textual, and auditory information

### 2.4 Edge AI and On-Device Intelligence

On-device AI processing has achieved remarkable efficiency gains. Mobile devices now run models with **7 billion parameters** locally, enabling privacy-preserving AI applications without cloud connectivity.

| Metric | 2024 | 2025 | 2026 |
| --- | --- | --- | --- |
| On-device model parameters | 3B | 5B | 7B |
| Inference latency (ms) | 120 | 65 | 28 |
| Power consumption (mW) | 850 | 520 | 310 |
| Accuracy vs cloud (%) | 82% | 91% | 96% |

## 3. Industry Applications

### 3.1 Healthcare

AI in healthcare has transitioned from experimental to essential. Diagnostic AI systems have received regulatory approval in **42 countries**, with some applications achieving superhuman diagnostic accuracy.

- **Radiology**: AI-assisted imaging reduces diagnostic errors by 47% and reading time by 63%
- **Drug Discovery**: AI-designed molecules enter clinical trials 3x faster than traditional methods
- **Personalized Medicine**: Genomic AI tailors treatment plans with 89% improved patient outcomes
- **Mental Health**: AI-powered chatbots provide 24/7 support, serving 180 million users globally

### 3.2 Finance

The financial sector has been an early and aggressive adopter of AI technology. Algorithmic trading powered by AI now accounts for **73% of all equity trades** in major markets.

- Fraud detection systems prevent **$38 billion** in losses annually
- AI credit scoring increases loan approval rates by 28% while reducing defaults by 35%
- Automated financial advisory services manage *$4.2 trillion* in assets
- RegTech AI reduces compliance costs by 61%

### 3.3 Manufacturing

Smart manufacturing powered by AI has ushered in the era of Industry 5.0, where human-AI collaboration optimizes every aspect of production.

- Predictive maintenance reduces unplanned downtime by **72%**
- Quality inspection AI achieves 99.97% defect detection accuracy
- Supply chain optimization saves manufacturers *$2.3 trillion* annually
- Digital twins powered by AI simulate entire factory operations in real-time

### 3.4 Education

AI is personalizing education at an unprecedented scale, with adaptive learning systems serving over **500 million students** worldwide.

- Personalized learning paths improve test scores by an average of 34%
- AI tutoring provides 24/7 individualized instruction
- Automated grading handles 78% of assessment workload
- Language learning AI accelerates fluency achievement by 2.5x

## 4. AI Ethics and Regulation

### 4.1 Global Regulatory Landscape

The regulatory environment for AI has matured significantly in 2026. Major developments include:

- **EU AI Act**: Fully enforced since February 2025, establishing risk-based classification
- **US AI Executive Order**: Extended with binding requirements for federal AI use
- **China AI Regulations**: Comprehensive framework covering generative AI, deepfakes, and algorithmic recommendations
- **Global AI Safety Summit**: 68 nations signed the Seoul-Tokyo Accord on AI Safety Standards

### 4.2 Ethical Challenges

Despite regulatory progress, significant ethical challenges remain:

- **Bias and Fairness**: Studies reveal persistent bias in 34% of deployed AI systems
- **Privacy**: Data collection practices for AI training face increasing scrutiny
- **Job Displacement**: An estimated 85 million jobs transformed by AI, with 58 million new roles created
- **Deepfakes**: AI-generated content detection remains an arms race
- **Autonomous Weapons**: International debates on AI in military applications intensify

### 4.3 Responsible AI Practices

Leading organizations have adopted comprehensive responsible AI frameworks:

| Practice | Adoption Rate | Impact |
| --- | --- | --- |
| AI Impact Assessments | 67% | Early risk identification |
| Algorithmic Auditing | 54% | Bias reduction by 42% |
| Transparency Reports | 48% | Increased public trust |
| Human-in-the-Loop | 72% | Error reduction by 58% |
| Data Governance | 81% | Compliance improvement |

## 5. Workforce and Talent

### 5.1 AI Talent Landscape

The demand for AI talent continues to outstrip supply, with **2.1 million unfilled AI positions** globally. Average compensation for senior AI researchers has reached $425,000 annually in the United States.

- Machine Learning Engineers: 340,000 unfilled positions globally
- Data Scientists: 520,000 unfilled positions globally
- AI Ethics Specialists: 85,000 unfilled positions globally
- AI Product Managers: 180,000 unfilled positions globally

### 5.2 Education and Upskilling

Universities and online platforms have dramatically expanded AI education offerings:

- **78 million** people enrolled in AI-related courses globally
- Top AI programs: Stanford, MIT, CMU, Tsinghua, KAIST, ETH Zurich
- Corporate AI training budgets average *$3,200 per employee* annually
- AI literacy programs reach 200 million workers in developing nations

## 6. Future Outlook (2027-2030)

### 6.1 Technology Predictions

- **Artificial General Intelligence (AGI)**: Leading researchers estimate 35% probability of AGI-level capabilities by 2030
- **Quantum-AI Integration**: Quantum computing will accelerate AI training by 1000x for specific problem classes
- **Neuromorphic Computing**: Brain-inspired chips will reduce AI energy consumption by 90%
- **AI-to-AI Communication**: Standardized protocols will enable seamless multi-agent collaboration

### 6.2 Market Projections

| Year | Market Size | Growth Rate | AI Workers |
| --- | --- | --- | --- |
| 2027 | $1.24T | 39.0% | 28M |
| 2028 | $1.72T | 38.7% | 35M |
| 2029 | $2.35T | 36.6% | 42M |
| 2030 | $3.18T | 35.3% | 50M |

### 6.3 Societal Impact

The next five years will be pivotal in determining how AI shapes society. Key areas to watch:

- Universal Basic Income discussions intensify as AI productivity gains accelerate
- AI-powered climate solutions could reduce global emissions by **18-25%**
- Healthcare AI could save *12 million lives annually* through early detection and precision medicine
- Education AI will provide personalized learning to every child globally by 2030

## 7. Recommendations

### 7.1 For Enterprises

1. Develop a comprehensive AI strategy aligned with business objectives
2. Invest in data infrastructure and governance frameworks
3. Build internal AI capabilities while leveraging strategic partnerships
4. Implement responsible AI practices from the design phase
5. Prepare workforce for AI-augmented roles through continuous upskilling

### 7.2 For Governments

1. Establish clear and balanced AI regulatory frameworks
2. Invest in AI research and education infrastructure
3. Foster international cooperation on AI safety standards
4. Protect workers through transition programs and social safety nets
5. Promote AI for public good initiatives in healthcare, education, and climate

### 7.3 For Individuals

1. Embrace lifelong learning and develop AI literacy skills
2. Focus on uniquely human capabilities: creativity, empathy, ethical reasoning
3. Leverage AI tools to enhance personal productivity and capabilities
4. Stay informed about AI developments and their implications
5. Participate in shaping AI policy through civic engagement

## Conclusion

The year 2026 marks a defining moment in the history of artificial intelligence. The technology has moved decisively from promise to practice, from laboratories to living rooms, from specialized applications to general-purpose tools that touch every aspect of human endeavor.

As we stand at this inflection point, the choices we make about how to develop, deploy, and govern AI will reverberate for generations. The opportunity before us is immense — AI has the potential to solve humanity's greatest challenges, from curing diseases to reversing climate change to eliminating poverty. But realizing this potential requires wisdom, foresight, and a commitment to ensuring that the benefits of AI are shared broadly and equitably.

The future of AI is not predetermined. It is being written now, by researchers in their laboratories, engineers at their keyboards, policymakers in their chambers, and citizens in their communities. This report is an invitation to participate in that writing — to shape an AI future that reflects our highest values and aspirations.

---

*This report was prepared by the Heureum AI Research Institute. For inquiries, contact research@heureum.ai*`;

// ─── Helper: chain edit tools using in-place overwrite ───

/** Apply edit, overwriting the same file (input === output) */
async function editInPlace<T extends { path: string; output_path?: string }>(
  fn: (args: T) => Promise<{ success: boolean; output: string }>,
  args: Omit<T, 'output_path'>,
): Promise<void> {
  const r = await fn({ ...args, output_path: (args as any).path } as T);
  if (!r.success) throw new Error(r.output);
}

// ─── Test Suite ─────────────────────────────────────────

describe('AI Report 2026 — Pipeline + Full Tool Chain', () => {

  // ═══ Phase 1: Pipeline (markdown → AST → XML → .hwpx) ═══

  it('pipeline 1/4: init_task', async () => {
    const r = await hwpxInitTask({
      session_id: SESSION,
      task_id: TASK,
      work_dir: WORK_DIR,
    });
    expect(r.success).toBe(true);
    expect(r.output).toContain('Task initialized');
  });

  it('pipeline 2/4: write_markdown → AST', async () => {
    const r = await hwpxWriteMarkdown({
      task_dir: TASK_DIR,
      markdown: REPORT_MD,
      persist_intermediate: true,
    });
    expect(r.success).toBe(true);
    expect(fs.existsSync(path.join(TASK_DIR, 'output/ast.json'))).toBe(true);
  });

  it('pipeline 3/4: write_xml → HWPX XML', async () => {
    const r = await hwpxWriteXml({
      task_dir: TASK_DIR,
      margin_top: 7087,     // 25mm
      margin_bottom: 7087,  // 25mm
      margin_left: 8504,    // 30mm
      margin_right: 7087,   // 25mm
      persist_intermediate: true,
    });
    expect(r.success).toBe(true);
    expect(fs.existsSync(path.join(TASK_DIR, 'output/hwpx/Contents/section0.xml'))).toBe(true);
  });

  it('pipeline 4/4: pack → result.hwpx', async () => {
    const r = await hwpxPack({ task_dir: TASK_DIR });
    expect(r.success).toBe(true);
    expect(fs.existsSync(step('result.hwpx'))).toBe(true);
  });

  // ═══ Phase 2: Edit chain (all tools on result.hwpx → final.hwpx) ═══

  const EDIT = () => step('editing.hwpx');

  it('edit: copy result → editing.hwpx', () => {
    fs.copyFileSync(step('result.hwpx'), EDIT());
    expect(fs.existsSync(EDIT())).toBe(true);
  });

  it('edit: page layout (set_page_layout)', async () => {
    const r = await hwpxSetPageLayout({
      path: EDIT(),
      margin_top_mm: 25,
      margin_bottom_mm: 25,
      margin_left_mm: 30,
      margin_right_mm: 25,
      output_path: EDIT(),
    });
    expect(r.success).toBe(true);
  });

  it('edit: title char format (set_char_format)', async () => {
    await editInPlace(hwpxSetCharFormat, {
      path: EDIT(),
      target_text: '2026 Artificial Intelligence Comprehensive Report',
      bold: true,
      font_size: 26,
      text_color: '#1A237E',
    });
  });

  it('edit: title paragraph (set_para_format)', async () => {
    await editInPlace(hwpxSetParaFormat, {
      path: EDIT(),
      target_text: '2026 Artificial Intelligence Comprehensive Report',
      alignment: 'CENTER',
      space_after: 3,  // mm
    });
  });

  it('edit: section heading styles (set_char_format x8)', async () => {
    const sections = [
      'Executive Summary',
      '1. Global AI Market Overview',
      '2. Technology Breakthroughs',
      '3. Industry Applications',
      '4. AI Ethics and Regulation',
      '5. Workforce and Talent',
      '6. Future Outlook (2027-2030)',
      '7. Recommendations',
    ];
    for (const title of sections) {
      await editInPlace(hwpxSetCharFormat, {
        path: EDIT(),
        target_text: title,
        bold: true,
        font_size: 16,
        text_color: '#1565C0',
      });
    }
  });

  it('edit: sub-section heading styles (set_char_format x22)', async () => {
    const subs = [
      'Market Size and Growth', 'Regional Distribution', 'Investment Landscape',
      'Large Language Models', 'AI Agents and Autonomous Systems', 'Multimodal AI',
      'Edge AI and On-Device Intelligence',
      'Healthcare', 'Finance', 'Manufacturing', 'Education',
      'Global Regulatory Landscape', 'Ethical Challenges', 'Responsible AI Practices',
      'AI Talent Landscape', 'Education and Upskilling',
      'Technology Predictions', 'Market Projections', 'Societal Impact',
      'For Enterprises', 'For Governments', 'For Individuals',
    ];
    for (const title of subs) {
      await editInPlace(hwpxSetCharFormat, {
        path: EDIT(),
        target_text: title,
        bold: true,
        font_size: 13,
        text_color: '#1976D2',
      });
    }
  });

  it('edit: table header backgrounds (edit_table_cell)', async () => {
    const tableCols = [5, 4, 4, 3, 4]; // column counts for each table
    for (let t = 0; t < tableCols.length; t++) {
      for (let c = 0; c < tableCols[t]; c++) {
        await editInPlace(hwpxEditTableCell, {
          path: EDIT(),
          table_index: t,
          row: 0,
          col: c,
          background_color: '#1565C0',
        });
      }
    }
  });

  it('edit: highlight total row in Market table (edit_table_cell)', async () => {
    for (let c = 0; c < 5; c++) {
      await editInPlace(hwpxEditTableCell, {
        path: EDIT(),
        table_index: 0,
        row: 6,
        col: c,
        background_color: '#E3F2FD',
      });
    }
  });

  it('edit: find/replace market figure (find_replace)', async () => {
    await editInPlace(hwpxFindReplace, {
      path: EDIT(),
      find: '$892.3 billion',
      replace: '$897.5 billion',
    });
  });

  it('edit: insert image (insert_image)', async () => {
    const imgPath = createTestPng();
    await editInPlace(hwpxInsertImage, {
      path: EDIT(),
      image_path: imgPath,
      width_mm: 120,
      height_mm: 80,
    });
  });

  it('edit: insert summary table (insert_table)', async () => {
    await editInPlace(hwpxInsertTable, {
      path: EDIT(),
      rows: 6,
      cols: 3,
      headers: ['AI Application', 'Impact Score (1-10)', 'Readiness Level'],
      data: [
        ['Healthcare Diagnostics', '9.2', 'Production'],
        ['Autonomous Vehicles', '8.5', 'Advanced Testing'],
        ['Drug Discovery', '8.8', 'Clinical Trials'],
        ['Financial Trading', '9.0', 'Production'],
        ['Climate Modeling', '7.9', 'Research/Pilot'],
      ],
    });
  });

  it('edit: header (set_header_footer)', async () => {
    await editInPlace(hwpxSetHeaderFooter, {
      path: EDIT(),
      type: 'header',
      text: 'Heureum AI Research Institute — Confidential',
      alignment: 'RIGHT',
    });
  });

  it('edit: footer (set_header_footer)', async () => {
    await editInPlace(hwpxSetHeaderFooter, {
      path: EDIT(),
      type: 'footer',
      text: '© 2026 Heureum AI Research Institute. All Rights Reserved.',
      alignment: 'CENTER',
    });
  });

  it('edit: insert disclaimer (insert_text)', async () => {
    await editInPlace(hwpxInsertText, {
      path: EDIT(),
      text: 'DISCLAIMER: This report contains forward-looking statements based on current expectations and assumptions. Actual results may differ materially from those projected. The information herein is provided for informational purposes only and should not be construed as investment advice.\n\nReport ID: HAIR-2026-Q1-001\nClassification: Confidential\nDistribution: Limited to authorized personnel only\nPublished: February 2026',
    });
  });

  it('edit: conclusion paragraph style (set_para_format)', async () => {
    await editInPlace(hwpxSetParaFormat, {
      path: EDIT(),
      target_text: 'The future of AI is not predetermined',
      alignment: 'CENTER',
      line_spacing: 180,
    });
  });

  it('edit: metadata → final.hwpx (set_metadata)', async () => {
    const r = await hwpxSetMetadata({
      path: EDIT(),
      title: '2026 Artificial Intelligence Comprehensive Report',
      author: 'Heureum AI Research Institute',
      subject: 'Annual AI Industry Analysis and Forecast',
      keywords: 'AI, Artificial Intelligence, Machine Learning, 2026, Market Report, Technology',
      output_path: step('final.hwpx'),
    });
    expect(r.success).toBe(true);
    expect(fs.existsSync(step('final.hwpx'))).toBe(true);

    // Clean up intermediate editing file
    if (fs.existsSync(EDIT())) fs.unlinkSync(EDIT());
  });
});

// ─── Demo: same report with hwpxCreateDocument (1 call) ──

describe('AI Report 2026 — hwpxCreateDocument (single call)', () => {
  it('creates the full report in one call', async () => {
    const imgPath = createTestPng();
    const outFile = path.join(OUTPUT_DIR, 'create-document-demo.hwpx');

    const r = await hwpxCreateDocument({
      output_path: outFile,
      title: '2026 Artificial Intelligence Comprehensive Report',
      font: '맑은 고딕',
      font_size: 10,
      margin: { top: 25, bottom: 25, left: 30, right: 25 },
      header: 'Heureum AI Research Institute — Confidential',
      footer: '© 2026 Heureum AI Research Institute. All Rights Reserved.',
      content: [
        // Title
        {
          paragraph: {
            text: '2026 Artificial Intelligence Comprehensive Report',
            heading: 1,
            fontSize: 26,
            color: '#1A237E',
            alignment: 'CENTER',
            spacing: { after: 800 },
          },
        },
        // Executive Summary heading
        {
          paragraph: {
            text: 'Executive Summary',
            heading: 2,
            fontSize: 16,
            color: '#1565C0',
          },
        },
        {
          paragraph: {
            text: 'The global artificial intelligence market has reached unprecedented levels of growth in 2026, fundamentally transforming industries across the spectrum.',
          },
        },
        // Section 1
        {
          paragraph: {
            text: '1. Global AI Market Overview',
            heading: 2,
            fontSize: 16,
            color: '#1565C0',
          },
        },
        {
          paragraph: {
            text: '1.1 Market Size and Growth',
            heading: 3,
            fontSize: 13,
            color: '#1976D2',
          },
        },
        {
          paragraph: {
            text: 'The global AI market is projected to reach $897.5 billion by the end of 2026.',
          },
        },
        // Market table
        {
          table: {
            rows: [
              ['Category', '2024 Market', '2025 Market', '2026 Projected', 'CAGR'],
              ['Machine Learning', '$165.2B', '$228.4B', '$312.7B', '37.5%'],
              ['Natural Language Processing', '$89.6B', '$134.2B', '$198.5B', '48.8%'],
              ['Computer Vision', '$72.3B', '$98.7B', '$138.4B', '38.4%'],
              ['Robotics & Automation', '$58.1B', '$82.5B', '$121.3B', '44.5%'],
              ['Generative AI', '$45.8B', '$78.9B', '$121.4B', '62.8%'],
              ['Total', '$431.0B', '$622.7B', '$897.5B', '38.1%'],
            ],
            headerRow: true,
            headerBackground: '#1565C0',
          },
        },
        // Regional bullets
        {
          paragraph: {
            text: '1.2 Regional Distribution',
            heading: 3,
            fontSize: 13,
            color: '#1976D2',
          },
        },
        { paragraph: { text: 'North America: $340.8B (38.2%)', bullet: true } },
        { paragraph: { text: 'Asia-Pacific: $285.4B (32.0%)', bullet: true } },
        { paragraph: { text: 'Europe: $178.5B (20.0%)', bullet: true } },
        { paragraph: { text: 'Rest of World: $87.6B (9.8%)', bullet: true } },
        // Page break + Section 2
        {
          paragraph: {
            text: '2. Technology Breakthroughs',
            heading: 2,
            fontSize: 16,
            color: '#1565C0',
            pageBreak: true,
          },
        },
        {
          paragraph: {
            text: '2.1 Large Language Models (LLMs)',
            heading: 3,
            fontSize: 13,
            color: '#1976D2',
          },
        },
        { paragraph: { text: 'Reasoning capabilities matching human expert-level performance', numbered: true } },
        { paragraph: { text: 'Real-time multilingual translation with 99.2% accuracy', numbered: true } },
        { paragraph: { text: 'Code generation achieving 87% first-pass success rate', numbered: true } },
        { paragraph: { text: 'Long-context windows exceeding 2 million tokens', numbered: true } },
        // Image
        { image: { path: imgPath, width_mm: 120, height_mm: 80 } },
        // Summary table
        {
          table: {
            rows: [
              ['AI Application', 'Impact Score', 'Readiness'],
              ['Healthcare Diagnostics', '9.2', 'Production'],
              ['Autonomous Vehicles', '8.5', 'Advanced Testing'],
              ['Drug Discovery', '8.8', 'Clinical Trials'],
            ],
            headerRow: true,
            headerBackground: '#0D47A1',
          },
        },
        // Conclusion
        { pageBreak: true },
        {
          paragraph: {
            text: 'Conclusion',
            heading: 2,
            fontSize: 16,
            color: '#1565C0',
          },
        },
        {
          paragraph: {
            text: 'The year 2026 marks a defining moment in the history of artificial intelligence.',
            alignment: 'CENTER',
            lineSpacing: 180,
          },
        },
        {
          paragraph: {
            text: 'This report was prepared by the Heureum AI Research Institute.',
            italic: true,
            alignment: 'CENTER',
          },
        },
      ],
    });

    expect(r.success).toBe(true);
    expect(fs.existsSync(outFile)).toBe(true);

    // Verify ZIP structure
    const buf = fs.readFileSync(outFile);
    const zip = await (await import('jszip')).default.loadAsync(buf);
    expect(zip.file('mimetype')).not.toBeNull();
    expect(zip.file('Contents/section0.xml')).not.toBeNull();
    expect(zip.file('Contents/header.xml')).not.toBeNull();

    // Verify content
    const section = await zip.file('Contents/section0.xml')!.async('string');
    expect(section).toContain('2026 Artificial Intelligence');
    expect(section).toContain('hp:tbl');
    expect(section).toContain('hp:pic');
    expect(section).toContain('hp:header');
    expect(section).toContain('hp:footer');
  });
});
