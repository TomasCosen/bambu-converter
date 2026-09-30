// Minimal XML helpers. Works both in the browser and in Node (no DOMParser needed).
// Only meant for the small metadata files inside a 3MF; meshes are scanned with regexes elsewhere.

const ENTITIES = { '&lt;': '<', '&gt;': '>', '&amp;': '&', '&quot;': '"', '&apos;': "'" };

export function decodeEntities(s) {
  if (!s || s.indexOf('&') < 0) return s;
  return s.replace(/&(lt|gt|amp|quot|apos|#\d+|#x[0-9a-fA-F]+);/g, (m) => {
    if (ENTITIES[m]) return ENTITIES[m];
    const code = m[2] === 'x' ? parseInt(m.slice(3, -1), 16) : parseInt(m.slice(2, -1), 10);
    return String.fromCodePoint(code);
  });
}

export function escapeXml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/\n/g, '&#10;');
}

const ATTR_RE = /([^\s=/>]+)\s*=\s*("([^"]*)"|'([^']*)')/g;

export function parseAttrs(s) {
  const attrs = {};
  let m;
  ATTR_RE.lastIndex = 0;
  while ((m = ATTR_RE.exec(s))) attrs[m[1]] = decodeEntities(m[3] !== undefined ? m[3] : m[4]);
  return attrs;
}

// Parses an XML document into { name, attrs, children, text } nodes. Returns the root element.
export function parseXml(src) {
  const root = { name: '#document', attrs: {}, children: [], text: '' };
  const stack = [root];
  let i = 0;
  const n = src.length;
  while (i < n) {
    const lt = src.indexOf('<', i);
    if (lt < 0) break;
    if (lt > i) {
      const t = src.slice(i, lt);
      if (t.trim()) stack[stack.length - 1].text += decodeEntities(t);
    }
    if (src.startsWith('<!--', lt)) {
      const end = src.indexOf('-->', lt + 4);
      i = end < 0 ? n : end + 3;
      continue;
    }
    if (src.startsWith('<![CDATA[', lt)) {
      const end = src.indexOf(']]>', lt + 9);
      stack[stack.length - 1].text += src.slice(lt + 9, end < 0 ? n : end);
      i = end < 0 ? n : end + 3;
      continue;
    }
    if (src[lt + 1] === '?' || src[lt + 1] === '!') {
      const end = src.indexOf('>', lt);
      i = end < 0 ? n : end + 1;
      continue;
    }
    const gt = findTagEnd(src, lt);
    const inner = src.slice(lt + 1, gt);
    i = gt + 1;
    if (inner[0] === '/') {
      if (stack.length > 1) stack.pop();
      continue;
    }
    const selfClose = inner.endsWith('/');
    const body = selfClose ? inner.slice(0, -1) : inner;
    const sp = body.search(/\s/);
    const name = sp < 0 ? body : body.slice(0, sp);
    const node = { name, attrs: sp < 0 ? {} : parseAttrs(body.slice(sp)), children: [], text: '' };
    stack[stack.length - 1].children.push(node);
    if (!selfClose) stack.push(node);
  }
  return root.children.find((c) => c.name) || root;
}

function findTagEnd(src, from) {
  let q = null;
  for (let j = from + 1; j < src.length; j++) {
    const c = src[j];
    if (q) {
      if (c === q) q = null;
    } else if (c === '"' || c === "'") q = c;
    else if (c === '>') return j;
  }
  return src.length - 1;
}

export function localName(name) {
  const k = name.indexOf(':');
  return k < 0 ? name : name.slice(k + 1);
}

export function children(node, name) {
  return node.children.filter((c) => localName(c.name) === name);
}

export function child(node, name) {
  return node.children.find((c) => localName(c.name) === name) || null;
}

// Depth-first search for all descendants with the given local name.
export function findAll(node, name, out = []) {
  for (const c of node.children) {
    if (localName(c.name) === name) out.push(c);
    findAll(c, name, out);
  }
  return out;
}

export function attr(node, name) {
  if (!node) return undefined;
  if (name in node.attrs) return node.attrs[name];
  for (const k of Object.keys(node.attrs)) if (localName(k) === name) return node.attrs[k];
  return undefined;
}

export function serializeXml(node, indent = '') {
  const a = Object.entries(node.attrs).map(([k, v]) => ` ${k}="${escapeXml(v)}"`).join('');
  if (!node.children.length && !node.text) return `${indent}<${node.name}${a}/>`;
  if (!node.children.length) return `${indent}<${node.name}${a}>${escapeXml(node.text)}</${node.name}>`;
  const inner = node.children.map((c) => serializeXml(c, indent + ' ')).join('\n');
  return `${indent}<${node.name}${a}>\n${inner}\n${indent}</${node.name}>`;
}
