/**
 * A deterministic YAML emitter for JSON-shaped data, in the exact style of contract/openapi.yaml:
 * two-space indentation, block sequences indented under their key, double-quoted strings unless a string is a
 * plain word that cannot be read as anything else, `[]` and `{}` for empty collections.
 * Deterministic output is what makes "CI fails on any diff" meaningful (FR-API-002).
 */
type Json = string | number | boolean | null | Json[] | { [key: string]: Json };

/** A string emitted without quotes: starts with a letter, `_` or `$`, then letters, digits and `_ . / -`. */
const PLAIN = /^[A-Za-z_$][A-Za-z0-9_./-]*$/;
/** Words YAML 1.1 or 1.2 would read as a boolean or null if left plain. */
const RESERVED = new Set(['true', 'false', 'null', 'yes', 'no', 'on', 'off', 'y', 'n', 'True', 'False', 'Null', 'TRUE', 'FALSE', 'NULL', 'Yes', 'No', 'On', 'Off', 'YES', 'NO', 'ON', 'OFF', 'Y', 'N', '~']);

function scalarString(value: string): string {
  return PLAIN.test(value) && !RESERVED.has(value) ? value : JSON.stringify(value);
}

function scalar(value: Exclude<Json, Json[] | { [key: string]: Json }>): string {
  if (value === null) {
    return 'null';
  }
  if (typeof value === 'string') {
    return scalarString(value);
  }
  return String(value);
}

function isCollection(value: Json): value is Json[] | { [key: string]: Json } {
  return typeof value === 'object' && value !== null;
}

function isEmpty(value: Json[] | { [key: string]: Json }): boolean {
  return Array.isArray(value) ? value.length === 0 : Object.keys(value).length === 0;
}

function emptyText(value: Json[] | { [key: string]: Json }): string {
  return Array.isArray(value) ? '[]' : '{}';
}

function emitMapping(map: { [key: string]: Json }, indent: string, lines: string[], firstPrefix?: string): void {
  let first = true;
  for (const [key, value] of Object.entries(map)) {
    const lead = first && firstPrefix !== undefined ? firstPrefix : indent;
    first = false;
    const keyText = `${lead}${scalarString(key)}:`;
    if (!isCollection(value)) {
      lines.push(`${keyText} ${scalar(value)}`);
    } else if (isEmpty(value)) {
      lines.push(`${keyText} ${emptyText(value)}`);
    } else if (Array.isArray(value)) {
      lines.push(keyText);
      emitSequence(value, `${indent}  `, lines);
    } else {
      lines.push(keyText);
      emitMapping(value, `${indent}  `, lines);
    }
  }
}

function emitSequence(items: Json[], indent: string, lines: string[]): void {
  for (const item of items) {
    if (!isCollection(item)) {
      lines.push(`${indent}- ${scalar(item)}`);
    } else if (isEmpty(item)) {
      lines.push(`${indent}- ${emptyText(item)}`);
    } else if (Array.isArray(item)) {
      lines.push(`${indent}-`);
      emitSequence(item, `${indent}  `, lines);
    } else {
      emitMapping(item, `${indent}  `, lines, `${indent}- `);
    }
  }
}

export function emitYaml(document: { [key: string]: Json }): string {
  const lines: string[] = [];
  emitMapping(document, '', lines);
  return `${lines.join('\n')}\n`;
}

export type { Json };
