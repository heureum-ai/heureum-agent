import { describe, it, expect } from 'vitest';
import { parseSectionXml } from '../src/reader.js';

describe('reader improvements', () => {
  it('parses charPr styles dynamically from header.xml', () => {
    const headerXml = `
<hh:head>
  <hh:refList>
    <hh:charProperties itemCnt="1">
      <hh:charPr id="21" height="1000" textColor="#000000" bold="1">
        <hh:fontRef hangul="3" latin="3" hanja="3" japanese="3" other="3" symbol="3" user="3"/>
      </hh:charPr>
    </hh:charProperties>
  </hh:refList>
</hh:head>`;

    const sectionXml = `
<hs:sec>
  <hp:p id="1" paraPrIDRef="0" styleIDRef="0" pageBreak="0" columnBreak="0" merged="0">
    <hp:run charPrIDRef="21"><hp:t>강조 텍스트</hp:t></hp:run>
  </hp:p>
</hs:sec>`;

    const nodes = parseSectionXml(sectionXml, headerXml);
    expect(nodes.length).toBe(1);
    expect(nodes[0].type).toBe('paragraph');
    expect(nodes[0].children[0].type).toBe('strong');
  });

  it('does not drop paragraphs that contain non-secPr ctrl nodes', () => {
    const sectionXml = `
<hs:sec>
  <hp:p id="1" paraPrIDRef="0" styleIDRef="0" pageBreak="0" columnBreak="0" merged="0">
    <hp:run charPrIDRef="0"><hp:t>앞</hp:t></hp:run>
    <hp:run charPrIDRef="0"><hp:ctrl><hp:autoNum num="1" numType="PAGE"/></hp:ctrl></hp:run>
    <hp:run charPrIDRef="0"><hp:t>뒤</hp:t></hp:run>
  </hp:p>
</hs:sec>`;

    const nodes = parseSectionXml(sectionXml);
    expect(nodes.length).toBe(1);
    expect(nodes[0].type).toBe('paragraph');
    const text = nodes[0].children.map((n: { value: string }) => n.value).join('');
    expect(text).toBe('앞뒤');
  });

  it('joins multiple hp:t texts inside table cells', () => {
    const sectionXml = `
<hs:sec>
  <hp:tbl id="10" numberingType="TABLE" textWrap="TOP_AND_BOTTOM" textFlow="BOTH_SIDES" lock="0" pageBreak="CELL" repeatHeader="1" rowCnt="1" colCnt="1" cellSpacing="0" borderFillIDRef="1" noAdjust="0">
    <hp:sz width="50159" widthRelTo="ABSOLUTE" height="0" heightRelTo="ABSOLUTE" protect="0"/>
    <hp:tr>
      <hp:tc name="" header="0" hasMargin="1" protect="0" editable="0" dirty="0" borderFillIDRef="1">
        <hp:subList id="" textDirection="HORIZONTAL" lineWrap="BREAK" vertAlign="CENTER" linkListIDRef="0" linkListNextIDRef="0" textWidth="0" textHeight="0" hasTextRef="0" hasNumRef="0">
          <hp:p id="11" paraPrIDRef="0" styleIDRef="0" pageBreak="0" columnBreak="0" merged="0">
            <hp:run charPrIDRef="0"><hp:t>첫</hp:t></hp:run>
            <hp:run charPrIDRef="0"><hp:t>째</hp:t></hp:run>
          </hp:p>
        </hp:subList>
      </hp:tc>
    </hp:tr>
  </hp:tbl>
</hs:sec>`;

    const nodes = parseSectionXml(sectionXml);
    expect(nodes.length).toBe(1);
    expect(nodes[0].type).toBe('table');
    expect(nodes[0].children[0].children[0].children[0].value).toBe('첫째');
  });

  it('preserves non-markdown run/paragraph styles via inline html', () => {
    const headerXml = `
<hh:head>
  <hh:refList>
    <hh:fontfaces itemCnt="1">
      <hh:fontface lang="HANGUL">
        <hh:font id="4" face="맑은 고딕" type="TTF"/>
      </hh:fontface>
    </hh:fontfaces>
    <hh:charProperties itemCnt="1">
      <hh:charPr id="12" height="1300" textColor="#0055AA" underline="1">
        <hh:fontRef hangul="4" latin="4" hanja="4" japanese="4" other="4" symbol="4" user="4"/>
      </hh:charPr>
    </hh:charProperties>
    <hh:paraProperties itemCnt="1">
      <hh:paraPr id="9">
        <hh:align horizontal="CENTER" vertical="BASELINE"/>
      </hh:paraPr>
    </hh:paraProperties>
  </hh:refList>
</hh:head>`;

    const sectionXml = `
<hs:sec>
  <hp:p id="1" paraPrIDRef="9" styleIDRef="0" pageBreak="0" columnBreak="0" merged="0">
    <hp:run charPrIDRef="12"><hp:t>정렬+서식</hp:t></hp:run>
  </hp:p>
</hs:sec>`;

    const nodes = parseSectionXml(sectionXml, headerXml);
    expect(nodes.length).toBe(1);
    expect(nodes[0].type).toBe('html');
    expect(nodes[0].value).toContain('text-align: center');
    expect(nodes[0].value).toContain('text-decoration: underline');
    expect(nodes[0].value).toContain('color: #0055AA');
    expect(nodes[0].value).toContain("font-family: '맑은 고딕'");
  });
});
