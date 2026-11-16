/**
 * Document templates (FR-DOC-004, FR-BIL-010, ADR-0061): a logic-less template language over a closed set of layout
 * tags, so a template can never run a script or fetch anything. A body is checked when it is saved, refused with every
 * broken rule named; a checked body renders render data to markup, and markup lays out into lines that the platform
 * writes as PDF or ESC/POS. The same body and data always give the same lines.
 *
 * Template syntax: `{{path}}` (a value, escaped), `{{#each path}}…{{/each}}` (a list; inside, paths are the item's and
 * `this` is the item), `{{#if path}}…{{/if}}` (shown when the value is present, not empty and not false). Nothing
 * else: no partials, helpers, unescaped output or comments.
 *
 * Layout tags, none with attributes: containers `header`, `footer`, `section`, `levies`; lines `h1`, `h2`, `p`,
 * `small`, `row` (whose `cell`s are columns) and the rule `<hr/>`. Text directly in a container is a line of its own.
 */

export interface BrokenTemplateRule {
  readonly rule:
    | 'TEMPLATE_TOO_LARGE'
    | 'SCRIPT_NOT_ALLOWED'
    | 'REMOTE_INCLUDE_NOT_ALLOWED'
    | 'TAG_NOT_ALLOWED'
    | 'ATTRIBUTE_NOT_ALLOWED'
    | 'TAG_NOT_CLOSED'
    | 'TAG_NOT_OPENED'
    | 'EXPRESSION_NOT_ALLOWED'
    | 'BLOCK_NOT_CLOSED'
    | 'BLOCK_NOT_OPENED';
  readonly detail: string;
}

export type LineStyle = 'h1' | 'h2' | 'p' | 'small';

/** One laid-out line: text, or a rule. */
export interface Line {
  readonly cells: readonly string[];
  readonly style: LineStyle;
  readonly center: boolean;
  readonly rule: boolean;
}

/** 64 KiB of source: a template is a page of layout, not a program. */
export const MAX_TEMPLATE_BYTES = 65_536;
const CONTAINERS = new Set(['header', 'footer', 'section', 'levies']);
const LINES = new Set(['h1', 'h2', 'p', 'small', 'row']);
const ALLOWED = new Set([...CONTAINERS, ...LINES, 'cell', 'hr']);
const PATH = /^(this|[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)*)$/;
/** Anything that could reach outside the template: a scheme, a protocol-relative URL, CSS imports and URLs. */
const REMOTE = /([a-z][a-z0-9+.-]{0,30}:\/\/)|(^|[\s"'(=])\/\/[^\s]|url\s*\(|@import|\bsrc\s*=|\bhref\s*=|\bdata:[a-z]+\//i;
// Bounded repetitions only: a body is checked in linear time, whatever it holds (no catastrophic backtracking).
const TAG = /<\s{0,8}(\/?)\s{0,8}([A-Za-z][A-Za-z0-9-]{0,30})([^<>]{0,200})>/g;

type Node =
  | { readonly kind: 'text'; readonly text: string }
  | { readonly kind: 'value'; readonly path: string }
  | { readonly kind: 'each' | 'if'; readonly path: string; readonly children: readonly Node[] };

interface Parsed {
  readonly nodes: readonly Node[];
  readonly broken: readonly BrokenTemplateRule[];
}

function parseTemplate(body: string): Parsed {
  const broken: BrokenTemplateRule[] = [];
  const root: Node[] = [];
  const stack: { kind: 'each' | 'if'; path: string; children: Node[] }[] = [];
  const top = () => (stack.length === 0 ? root : stack[stack.length - 1]!.children);
  const expression = /\{\{([^{}]{0,200})\}\}(\})?/g;
  let last = 0;
  for (const match of body.matchAll(expression)) {
    if (match.index > last) top().push({ kind: 'text', text: body.slice(last, match.index) });
    last = match.index + match[0].length;
    const inner = match[1]!.trim();
    const block = /^#(each|if)\s+(\S+)$/.exec(inner);
    const close = /^\/(each|if)$/.exec(inner);
    if (match[2] !== undefined || inner.startsWith('{')) {
      broken.push({ rule: 'EXPRESSION_NOT_ALLOWED', detail: `{{${inner}}}: unescaped output is not allowed` });
    } else if (block !== null && PATH.test(block[2]!)) {
      stack.push({ kind: block[1] as 'each' | 'if', path: block[2]!, children: [] });
    } else if (close !== null) {
      const open = stack.pop();
      if (open === undefined || open.kind !== close[1]) {
        broken.push({ rule: 'BLOCK_NOT_OPENED', detail: `{{${inner}}} closes no open {{#${close[1]}}}` });
        if (open !== undefined) stack.push(open);
      } else {
        top().push({ kind: open.kind, path: open.path, children: open.children });
      }
    } else if (PATH.test(inner)) {
      top().push({ kind: 'value', path: inner });
    } else {
      broken.push({ rule: 'EXPRESSION_NOT_ALLOWED', detail: `{{${inner}}} is not a value, an #each or an #if` });
    }
  }
  if (last < body.length) top().push({ kind: 'text', text: body.slice(last) });
  if (/\{\{|\}\}/.test(body.replace(expression, ''))) broken.push({ rule: 'EXPRESSION_NOT_ALLOWED', detail: 'every {{ closes with }} around a value, an #each or an #if' });
  for (const open of stack) broken.push({ rule: 'BLOCK_NOT_CLOSED', detail: `{{#${open.kind} ${open.path}}} is never closed` });
  return { nodes: root, broken };
}

/** The tags in one run of template text at one block level must open and close within it. */
function checkTags(nodes: readonly Node[], broken: BrokenTemplateRule[]): void {
  const text = nodes.map((n) => (n.kind === 'text' ? n.text : ' ')).join('');
  const open: string[] = [];
  const stray = text.split('<').length - 1 - [...text.matchAll(TAG)].length;
  if (stray > 0) broken.push({ rule: 'TAG_NOT_ALLOWED', detail: 'a < that opens no layout tag: write &lt; for the character' });
  for (const match of text.matchAll(TAG)) {
    const [, slash, rawName, rest] = match;
    const name = rawName!.toLowerCase();
    if (name === 'script') {
      broken.push({ rule: 'SCRIPT_NOT_ALLOWED', detail: 'a template never runs a script' });
      continue;
    }
    if (!ALLOWED.has(name)) {
      broken.push({ rule: 'TAG_NOT_ALLOWED', detail: `<${name}> is not a layout tag` });
      continue;
    }
    const selfClosing = /\/\s*$/.test(rest!);
    if (rest!.replace(/\/\s*$/, '').trim() !== '') broken.push({ rule: 'ATTRIBUTE_NOT_ALLOWED', detail: `<${name}> takes no attributes` });
    if (name === 'hr') continue;
    if (slash === '/') {
      if (open.at(-1) === name) open.pop();
      else broken.push({ rule: 'TAG_NOT_OPENED', detail: `</${name}> closes no open <${name}>` });
    } else if (!selfClosing) {
      open.push(name);
    }
  }
  for (const name of open) broken.push({ rule: 'TAG_NOT_CLOSED', detail: `<${name}> is never closed` });
  for (const node of nodes) if (node.kind === 'each' || node.kind === 'if') checkTags(node.children, broken);
}

/** Every rule a template body breaks; empty when it may be saved. */
export function checkTemplateBody(body: string): BrokenTemplateRule[] {
  if (Buffer.byteLength(body, 'utf8') > MAX_TEMPLATE_BYTES) return [{ rule: 'TEMPLATE_TOO_LARGE', detail: `a template body is at most ${MAX_TEMPLATE_BYTES} bytes` }];
  const parsed = parseTemplate(body);
  const broken = [...parsed.broken];
  if (REMOTE.test(body)) broken.push({ rule: 'REMOTE_INCLUDE_NOT_ALLOWED', detail: 'a template never refers to anything outside itself' });
  checkTags(parsed.nodes, broken);
  return broken;
}

export class TemplateBodyInvalidError extends Error {
  constructor(readonly broken: readonly BrokenTemplateRule[]) {
    super(`template body refused: ${broken.map((b) => b.rule).join(', ')}`);
    this.name = 'TemplateBodyInvalidError';
  }
}

function lookup(scope: readonly unknown[], path: string): unknown {
  if (path === 'this') return scope[scope.length - 1];
  const parts = path.split('.');
  for (let i = scope.length - 1; i >= 0; i -= 1) {
    let value: unknown = scope[i];
    if (value === null || typeof value !== 'object' || !Object.hasOwn(value, parts[0]!)) continue;
    for (const part of parts) {
      value = value !== null && typeof value === 'object' && Object.hasOwn(value, part) ? (value as Record<string, unknown>)[part] : undefined;
    }
    return value;
  }
  return undefined;
}

const escapeText = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function show(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') return String(value);
  return '';
}

function truthy(value: unknown): boolean {
  if (Array.isArray(value)) return value.length > 0;
  return value !== undefined && value !== null && value !== false && value !== '';
}

function renderNodes(nodes: readonly Node[], scope: readonly unknown[]): string {
  let out = '';
  for (const node of nodes) {
    if (node.kind === 'text') out += node.text;
    else if (node.kind === 'value') out += escapeText(show(lookup(scope, node.path)));
    else if (node.kind === 'if') out += truthy(lookup(scope, node.path)) ? renderNodes(node.children, scope) : '';
    else {
      const list = lookup(scope, node.path);
      if (Array.isArray(list)) for (const item of list) out += renderNodes(node.children, [...scope, item]);
    }
  }
  return out;
}

/** Renders a checked body with the data to markup. A body that breaks a rule is refused here too. */
export function renderTemplate(body: string, data: Record<string, unknown>): string {
  const broken = checkTemplateBody(body);
  if (broken.length > 0) throw new TemplateBodyInvalidError(broken);
  return renderNodes(parseTemplate(body).nodes, [data]);
}

const decode = (text: string) => text.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
const squash = (text: string) => decode(text.replace(/\s+/g, ' ').trim());

/** Lays rendered markup out into lines, in order. Text outside any line tag is a paragraph of its own. */
export function layoutMarkup(markup: string): Line[] {
  const lines: Line[] = [];
  const containers: string[] = [];
  let lineTag: string | null = null;
  let cells: string[] = [];
  let cell: string | null = null;
  let text = '';
  const center = () => containers.includes('header') || containers.includes('footer');
  const styleOf = (tag: string | null): LineStyle => (tag === 'h1' || tag === 'h2' || tag === 'small' ? tag : containers.includes('footer') ? 'small' : 'p');
  const flushLoose = () => {
    const loose = squash(text);
    text = '';
    if (loose !== '') lines.push({ cells: [loose], style: styleOf(null), center: center(), rule: false });
  };
  let last = 0;
  for (const match of markup.matchAll(TAG)) {
    const between = markup.slice(last, match.index);
    last = match.index + match[0].length;
    if (cell !== null) cell += between;
    else text += between;
    const closing = match[1] === '/';
    const name = match[2]!.toLowerCase();
    if (name === 'hr') {
      flushLoose();
      lines.push({ cells: [], style: 'p', center: false, rule: true });
    } else if (name === 'cell') {
      if (closing && cell !== null) {
        cells.push(squash(cell));
        cell = null;
      } else if (!closing) {
        text = '';
        cell = '';
      }
    } else if (LINES.has(name)) {
      if (!closing) {
        flushLoose();
        lineTag = name;
        cells = [];
      } else {
        const loose = squash(text);
        text = '';
        const all = cells.length === 0 ? [loose] : loose === '' ? cells : [...cells, loose];
        lines.push({ cells: all, style: styleOf(lineTag), center: center() && all.length === 1, rule: false });
        lineTag = null;
        cells = [];
      }
    } else if (CONTAINERS.has(name)) {
      flushLoose();
      if (closing) containers.pop();
      else containers.push(name);
    }
  }
  text += markup.slice(last);
  flushLoose();
  return lines;
}
