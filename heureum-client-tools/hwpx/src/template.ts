/**
 * Fixed XML templates extracted from a valid HWPX reference file.
 * Dynamic builders for container.rdf and content.hpf.
 */

import { HWPX_DEFAULTS } from './configs.js';

export const MIMETYPE = 'application/hwp+zip';

export const VERSION_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes" ?>
<hv:HCFVersion xmlns:hv="http://www.hancom.co.kr/hwpml/2011/version"
  tagetApplication="WORDPROCESSOR"
  major="5" minor="1" micro="0" buildNumber="1"
  os="1" xmlVersion="1.4"
  application="Hancom Office Hangul"
  appVersion="11, 0, 0, 8778 WIN32LEWindows_10"/>`;

export const CONTAINER_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes" ?>
<ocf:container xmlns:ocf="urn:oasis:names:tc:opendocument:xmlns:container"
               xmlns:hpf="http://www.hancom.co.kr/schema/2011/hpf">
  <ocf:rootfiles>
    <ocf:rootfile full-path="Contents/content.hpf" media-type="application/hwpml-package+xml"/>
    <ocf:rootfile full-path="Preview/PrvText.txt" media-type="text/plain"/>
    <ocf:rootfile full-path="META-INF/container.rdf" media-type="application/rdf+xml"/>
  </ocf:rootfiles>
</ocf:container>`;

export const MANIFEST_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes" ?>
<odf:manifest xmlns:odf="urn:oasis:names:tc:opendocument:xmlns:manifest:1.0"/>`;

export const SETTINGS_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes" ?>
<ha:HWPApplicationSetting xmlns:ha="http://www.hancom.co.kr/hwpml/2011/app"
                           xmlns:config="urn:oasis:names:tc:opendocument:xmlns:config:1.0">
  <ha:CaretPosition listIDRef="0" paraIDRef="0" pos="0"/>
  <config:config-item-set name="PrintInfo">
    <config:config-item name="PrintAutoFootNote" type="boolean">false</config:config-item>
    <config:config-item name="PrintAutoHeadNote" type="boolean">false</config:config-item>
    <config:config-item name="PrintMethod" type="short">0</config:config-item>
    <config:config-item name="OverlapSize" type="short">0</config:config-item>
    <config:config-item name="PrintCropMark" type="short">0</config:config-item>
    <config:config-item name="BinderHoleType" type="short">0</config:config-item>
    <config:config-item name="ZoomX" type="short">100</config:config-item>
    <config:config-item name="ZoomY" type="short">100</config:config-item>
  </config:config-item-set>
</ha:HWPApplicationSetting>`;

const NS_PKG = 'http://www.hancom.co.kr/hwpml/2016/meta/pkg#';

export function buildContainerRdf(sectionCount: number): string {
  let parts = `<?xml version="1.0" encoding="UTF-8" standalone="yes" ?>\n`;
  parts += `<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">\n`;

  // Header reference
  parts += `  <rdf:Description rdf:about="">\n`;
  parts += `    <ns0:hasPart xmlns:ns0="${NS_PKG}" rdf:resource="Contents/header.xml"/>\n`;
  parts += `  </rdf:Description>\n`;
  parts += `  <rdf:Description rdf:about="Contents/header.xml">\n`;
  parts += `    <rdf:type rdf:resource="${NS_PKG}HeaderFile"/>\n`;
  parts += `  </rdf:Description>\n`;

  // Section references
  for (let i = 0; i < sectionCount; i++) {
    parts += `  <rdf:Description rdf:about="">\n`;
    parts += `    <ns0:hasPart xmlns:ns0="${NS_PKG}" rdf:resource="Contents/section${i}.xml"/>\n`;
    parts += `  </rdf:Description>\n`;
    parts += `  <rdf:Description rdf:about="Contents/section${i}.xml">\n`;
    parts += `    <rdf:type rdf:resource="${NS_PKG}SectionFile"/>\n`;
    parts += `  </rdf:Description>\n`;
  }

  // Document type
  parts += `  <rdf:Description rdf:about="">\n`;
  parts += `    <rdf:type rdf:resource="${NS_PKG}Document"/>\n`;
  parts += `  </rdf:Description>\n`;
  parts += `</rdf:RDF>`;
  return parts;
}

const COMMON_NS = [
  'xmlns:ha="http://www.hancom.co.kr/hwpml/2011/app"',
  'xmlns:hp="http://www.hancom.co.kr/hwpml/2011/paragraph"',
  'xmlns:hp10="http://www.hancom.co.kr/hwpml/2016/paragraph"',
  'xmlns:hs="http://www.hancom.co.kr/hwpml/2011/section"',
  'xmlns:hc="http://www.hancom.co.kr/hwpml/2011/core"',
  'xmlns:hh="http://www.hancom.co.kr/hwpml/2011/head"',
  'xmlns:hhs="http://www.hancom.co.kr/hwpml/2011/history"',
  'xmlns:hm="http://www.hancom.co.kr/hwpml/2011/master-page"',
  'xmlns:hpf="http://www.hancom.co.kr/schema/2011/hpf"',
  'xmlns:dc="http://purl.org/dc/elements/1.1/"',
  'xmlns:opf="http://www.idpf.org/2007/opf/"',
  'xmlns:ooxmlchart="http://www.hancom.co.kr/hwpml/2016/ooxmlchart"',
  'xmlns:hwpunitchar="http://www.hancom.co.kr/hwpml/2016/HwpUnitChar"',
  'xmlns:epub="http://www.idpf.org/2007/ops"',
  'xmlns:config="urn:oasis:names:tc:opendocument:xmlns:config:1.0"',
].join('\n             ');

export { COMMON_NS };

export interface ContentHpfBinItem {
  id: string;
  href: string;
  mediaType: string;
}

export function buildContentHpf(
  sectionCount: number,
  title?: string,
  binItems?: ContentHpfBinItem[],
): string {
  const now = new Date().toISOString().replace('T', ' ').slice(0, 19);
  const docTitle = title || HWPX_DEFAULTS.metadata.title;

  let manifest = '';
  manifest += `    <opf:item id="header" href="Contents/header.xml" media-type="application/xml"/>\n`;
  for (let i = 0; i < sectionCount; i++) {
    manifest += `    <opf:item id="section${i}" href="Contents/section${i}.xml" media-type="application/xml"/>\n`;
  }
  manifest += `    <opf:item id="settings" href="settings.xml" media-type="application/xml"/>`;
  if (binItems && binItems.length > 0) {
    manifest += '\n';
    for (const item of binItems) {
      manifest += `    <opf:item id="${escapeXml(item.id)}" href="${escapeXml(item.href)}" media-type="${escapeXml(item.mediaType)}" isEmbeded="1"/>\n`;
    }
    manifest = manifest.trimEnd();
  }

  let spine = `    <opf:itemref idref="header" linear="yes"/>\n`;
  for (let i = 0; i < sectionCount; i++) {
    spine += `    <opf:itemref idref="section${i}"/>\n`;
  }

  return `<?xml version="1.0" encoding="UTF-8" standalone="yes" ?>
<opf:package ${COMMON_NS}
             version="" unique-identifier="" id="">
  <opf:metadata>
    <opf:title>${escapeXml(docTitle)}</opf:title>
    <opf:language>${HWPX_DEFAULTS.metadata.language}</opf:language>
    <opf:meta name="creator" content="text">${escapeXml(HWPX_DEFAULTS.metadata.creator)}</opf:meta>
    <opf:meta name="subject" content="text"/>
    <opf:meta name="description" content="text"/>
    <opf:meta name="lastsaveby" content="text">${escapeXml(HWPX_DEFAULTS.metadata.lastSaveBy)}</opf:meta>
    <opf:meta name="CreatedDate" content="text">${now}</opf:meta>
    <opf:meta name="ModifiedDate" content="text">${now}</opf:meta>
    <opf:meta name="date" content="text">${now}</opf:meta>
    <opf:meta name="keyword" content="text"/>
  </opf:metadata>
  <opf:manifest>
${manifest}
  </opf:manifest>
  <opf:spine>
${spine}  </opf:spine>
</opf:package>`;
}

export function escapeXml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
    .replace(/[\r\n]+/g, ' ');
}
