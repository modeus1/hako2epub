// Builds an EPUB 3 file (with an NCX fallback for older readers) from parsed
// novel data. Everything happens in memory, so no server or build step needed.

import { ZipWriter } from './zip.js';
import { escapeXml } from './dom.js';

const STYLE = `body { font-family: serif; line-height: 1.5; margin: 0 5%; }
h1, h2, h3, h4 { text-align: center; line-height: 1.3; }
img { max-width: 100%; height: auto; }
.cover img { display: block; margin: 0 auto; max-height: 100%; }
#cover { display: block; margin: 0 auto; max-width: 100%; }
p { margin: 0.6em 0; }
`;

function chapterFile(index) {
  return `chap_${index + 1}.xhtml`;
}

function page(title, body) {
  return `<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xml:lang="vi" lang="vi">
<head>
<meta charset="utf-8" />
<title>${escapeXml(title)}</title>
<link rel="stylesheet" type="text/css" href="style.css" />
</head>
<body>
${body}
</body>
</html>
`;
}

function navDocument(title, entries) {
  const items = entries
    .map((entry) => `      <li><a href="${entry.href}">${escapeXml(entry.title)}</a></li>`)
    .join('\n');
  return `<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" xml:lang="vi" lang="vi">
<head>
<meta charset="utf-8" />
<title>${escapeXml(title)}</title>
<link rel="stylesheet" type="text/css" href="style.css" />
</head>
<body>
  <nav epub:type="toc" id="toc">
    <h1>Table of Contents</h1>
    <ol>
${items}
    </ol>
  </nav>
</body>
</html>
`;
}

function ncxDocument(identifier, title, entries) {
  const points = entries
    .map((entry, index) => `    <navPoint id="navPoint-${index + 1}" playOrder="${index + 1}">
      <navLabel><text>${escapeXml(entry.title)}</text></navLabel>
      <content src="${entry.href}" />
    </navPoint>`)
    .join('\n');
  return `<?xml version="1.0" encoding="utf-8"?>
<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1">
  <head>
    <meta name="dtb:uid" content="${escapeXml(identifier)}" />
    <meta name="dtb:depth" content="1" />
  </head>
  <docTitle><text>${escapeXml(title)}</text></docTitle>
  <navMap>
${points}
  </navMap>
</ncx>
`;
}

const IMAGE_EXTENSIONS = {
  'image/jpeg': 'jpeg',
  'image/png': 'png',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/svg+xml': 'svg',
};

function mediaTypeFromMime(mime) {
  const value = String(mime || '').split(';')[0].trim().toLowerCase();
  return IMAGE_EXTENSIONS[value] ? value : 'image/jpeg';
}

function extensionFromMime(mime) {
  return IMAGE_EXTENSIONS[mediaTypeFromMime(mime)] || 'jpeg';
}

/**
 * @param {object} input
 * @param {{name: string, author?: string, seriesInfoHtml?: string, factItemHtml?: string}} input.novel
 * @param {{name: string}} input.volume
 * @param {Array<{title: string, xhtml: string, images?: Array<{path: string, mime: string, data: Uint8Array}>}>} input.chapters
 * @param {{mime: string, data: Uint8Array}|null} input.cover
 * @returns {Uint8Array} the finished .epub bytes
 */
export function buildEpub({ novel, volume, chapters, cover }) {
  const zip = new ZipWriter();
  const identifier = `urn:uuid:${crypto.randomUUID()}`;
  const bookTitle = `${novel.name} - ${volume.name}`;
  const modified = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');

  zip.add('mimetype', 'application/epub+zip');
  zip.add('META-INF/container.xml', `<?xml version="1.0" encoding="utf-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml" />
  </rootfiles>
</container>
`);

  const manifest = [
    '    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav" />',
    '    <item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml" />',
    '    <item id="style" href="style.css" media-type="text/css" />',
    '    <item id="intro" href="intro.xhtml" media-type="application/xhtml+xml" />',
  ];
  const spine = ['    <itemref idref="intro" />'];
  const tocEntries = [];

  let coverMarkup = '';
  if (cover && cover.data && cover.data.length) {
    const mime = mediaTypeFromMime(cover.mime);
    const extension = extensionFromMime(cover.mime);
    zip.add(`OEBPS/cover.${extension}`, cover.data);
    manifest.push(`    <item id="cover-image" href="cover.${extension}" media-type="${mime}" properties="cover-image" />`);
    coverMarkup = `<div class="cover"><img id="cover" src="cover.${extension}" alt="${escapeXml(novel.name)}" /></div>`;
  }

  const introBody = `<div style="text-align: center">
${coverMarkup}
<h1>${escapeXml(novel.name)}</h1>
<h3>${escapeXml(volume.name)}</h3>
</div>
${novel.seriesInfoHtml || ''}
${novel.factItemHtml || ''}
`;
  zip.add('OEBPS/intro.xhtml', page(volume.name, introBody));

  chapters.forEach((chapter, index) => {
    const file = chapterFile(index);
    zip.add(`OEBPS/${file}`, page(chapter.title, chapter.xhtml));
    manifest.push(`    <item id="chap-${index + 1}" href="${file}" media-type="application/xhtml+xml" />`);
    spine.push(`    <itemref idref="chap-${index + 1}" />`);
    tocEntries.push({ title: chapter.title, href: file });

    (chapter.images || []).forEach((image, imageIndex) => {
      const id = `img-${index + 1}-${imageIndex + 1}`;
      zip.add(`OEBPS/${image.path}`, image.data);
      manifest.push(`    <item id="${id}" href="${image.path}" media-type="${mediaTypeFromMime(image.mime)}" />`);
    });
  });

  const navEntries = [{ title: 'Introduction', href: 'intro.xhtml' }, ...tocEntries];
  zip.add('OEBPS/nav.xhtml', navDocument(bookTitle, navEntries));
  zip.add('OEBPS/toc.ncx', ncxDocument(identifier, bookTitle, navEntries));
  zip.add('OEBPS/style.css', STYLE);

  const metadataExtra = cover
    ? `    <meta name="cover" content="cover-image" />\n`
    : '';
  const opf = `<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="bookid" xml:lang="vi">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="bookid">${escapeXml(identifier)}</dc:identifier>
    <dc:title>${escapeXml(bookTitle)}</dc:title>
    <dc:language>vi</dc:language>
    <dc:creator>${escapeXml(novel.author || 'Unknown')}</dc:creator>
    <dc:source>${escapeXml(novel.url || '')}</dc:source>
    <meta property="dcterms:modified">${modified}</meta>
${metadataExtra}  </metadata>
  <manifest>
${manifest.join('\n')}
  </manifest>
  <spine toc="ncx">
${spine.join('\n')}
  </spine>
</package>
`;
  zip.add('OEBPS/content.opf', opf);

  return zip.build();
}
