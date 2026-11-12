// Small DOM helpers shared by the parser and the EPUB builder.

const parser = new DOMParser();
const serializer = new XMLSerializer();

/** Parse an HTML document from a response body. */
export function parseHtml(text) {
  return parser.parseFromString(String(text ?? ''), 'text/html');
}

/** Collapse whitespace runs the way the desktop tool's format_text() does. */
export function cleanText(text) {
  return String(text ?? '').replace(/\s+/g, ' ').trim();
}

/** Wrap a raw HTML fragment so it can be parsed. */
export function wrapFragment(fragmentHtml) {
  return `<!DOCTYPE html><html><body>${fragmentHtml}</body></html>`;
}

const UNSAFE_TAGS = [
  'script', 'iframe', 'object', 'embed', 'form', 'input', 'button', 'select',
  'textarea', 'link', 'meta', 'base', 'frameset', 'frame', 'noscript',
];

/**
 * Drop anything that must not be shipped inside an EPUB: scripts, embedded
 * frames, forms and inline event handlers. Styling is left untouched.
 */
export function sanitize(root) {
  if (!root) return root;
  for (const tag of UNSAFE_TAGS) {
    for (const element of root.querySelectorAll(tag)) element.remove();
  }
  const elements = root.querySelectorAll('*');
  const all = root.nodeType === 1 ? [root, ...elements] : [...elements];
  for (const element of all) {
    for (const attribute of [...element.attributes]) {
      const name = attribute.name.toLowerCase();
      const value = String(attribute.value || '').trim();
      if (name.startsWith('on')) {
        element.removeAttribute(attribute.name);
      } else if ((name === 'href' || name === 'src' || name === 'xlink:href')
        && /^\s*(javascript|vbscript|data):/i.test(value)) {
        element.removeAttribute(attribute.name);
      } else if (name.startsWith(':')) {
        // Vue binding leftovers such as :href / @click.
        element.removeAttribute(attribute.name);
      }
    }
  }
  return root;
}

/** Serialise DOM content as well-formed XHTML. */
export function serializeXhtml(node) {
  if (!node) return '';
  const html = serializer.serializeToString(node);
  // XMLSerializer may leave an XML declaration out, but strips stray namespaces
  // are not needed here: nodes come from a plain HTML document.
  return html.replace(/^<\?xml[^>]*\?>\s*/, '');
}

/** Sanitise a node and return it as XHTML markup. */
export function safeXhtml(node) {
  return serializeXhtml(sanitize(node));
}

export function escapeXml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (character) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  }[character]));
}
