import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';
import { emitYaml } from './yaml-emitter';

describe('the contract YAML emitter', () => {
  it('writes plain words unquoted and everything else double-quoted', () => {
    expect(
      emitYaml({
        operationId: 'getHealth',
        $ref: '#/components/schemas/Health',
        summary: 'Report system health',
        version: '1.0.0+9f3c2a1',
        name: '__Host-hk_s_at',
        status: 'OK',
      }),
    ).toBe(
      'operationId: getHealth\n$ref: "#/components/schemas/Health"\nsummary: "Report system health"\nversion: "1.0.0+9f3c2a1"\nname: __Host-hk_s_at\nstatus: OK\n',
    );
  });

  it('quotes words YAML would read as a boolean or null, and keys that start with a digit or slash', () => {
    expect(emitYaml({ '200': { type: ['string', 'null'] }, '/health': { enabled: 'yes' } })).toBe(
      '"200":\n  type:\n    - string\n    - "null"\n"/health":\n  enabled: "yes"\n',
    );
  });

  it('writes numbers, booleans, null and empty collections as YAML scalars', () => {
    expect(emitYaml({ limit: 25, required: true, detail: null, security: [], extensions: {} })).toBe(
      'limit: 25\nrequired: true\ndetail: null\nsecurity: []\nextensions: {}\n',
    );
  });

  it('indents sequences of mappings and nested sequences under their key', () => {
    expect(emitYaml({ security: [{ staffSession: [] }, { apiKey: [] }], matrix: [[1, 2], []] })).toBe(
      'security:\n  - staffSession: []\n  - apiKey: []\nmatrix:\n  -\n    - 1\n    - 2\n  - []\n',
    );
  });

  it('escapes newlines and quotes so the text parses back to the same value', () => {
    const value = { description: 'Line one.\n\nSays "hello" and C:\\path' };
    const text = emitYaml(value);
    expect(text).toBe('description: "Line one.\\n\\nSays \\"hello\\" and C:\\\\path"\n');
    expect(parse(text)).toEqual(value);
  });
});
