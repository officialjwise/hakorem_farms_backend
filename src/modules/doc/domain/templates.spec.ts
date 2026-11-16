import { describe, expect, it } from 'vitest';
import { checkTemplateBody, layoutMarkup, MAX_TEMPLATE_BYTES, renderTemplate, TemplateBodyInvalidError } from './templates';

const rules = (body: string) => checkTemplateBody(body).map((b) => b.rule);

describe('checkTemplateBody refuses at save what could run or fetch (FR-DOC-004)', () => {
  it('accepts the contract example and every layout tag', () => {
    expect(
      rules(
        '<header>{{business.tradingName}}</header><h1>Receipt {{documentNo}}</h1>{{#each lines}}<row>{{description}} {{quantity}} {{lineGross}}</row>{{/each}}<levies>{{#each levyTotals}}{{levyName}} {{amount}}{{/each}}</levies>',
      ),
    ).toEqual([]);
    expect(rules('<section><h2>a</h2><p>b</p><small>c</small><row><cell>d</cell><cell>e</cell></row><hr/><hr></section><footer>f</footer>{{#if x}}<p>{{this}}</p>{{/if}}')).toEqual([]);
  });

  it('refuses a script, in any case and however it is written', () => {
    expect(rules('<p>x</p><script>alert(1)</script>')).toContain('SCRIPT_NOT_ALLOWED');
    expect(rules('<SCRIPT src="a.js"></SCRIPT>')).toContain('SCRIPT_NOT_ALLOWED');
    expect(rules('< script >x</ script >')).toContain('SCRIPT_NOT_ALLOWED');
  });

  it('refuses a remote include: a URL, a protocol-relative link, a CSS import or url(), a data URI', () => {
    for (const body of [
      '<p>https://evil.example/logo.png</p>',
      '<p>see //cdn.example/x</p>',
      '<p>@import "x.css"</p>',
      '<p>url(x.png)</p>',
      '<p>data:image/png;base64,AAAA</p>',
    ]) {
      expect(rules(body), body).toContain('REMOTE_INCLUDE_NOT_ALLOWED');
    }
  });

  it('refuses any other tag and any attribute', () => {
    expect(rules('<img>')).toEqual(['TAG_NOT_ALLOWED']);
    expect(rules('<iframe></iframe>')).toEqual(['TAG_NOT_ALLOWED', 'TAG_NOT_ALLOWED']);
    expect(rules('<p onclick="x">a</p>')).toEqual(['ATTRIBUTE_NOT_ALLOWED']);
    expect(rules('<p style="color:red">a</p>')).toEqual(['ATTRIBUTE_NOT_ALLOWED']);
  });

  it('refuses unbalanced tags, also across a block boundary', () => {
    expect(rules('<p>a')).toEqual(['TAG_NOT_CLOSED']);
    expect(rules('a</p>')).toEqual(['TAG_NOT_OPENED']);
    expect(rules('{{#if x}}<p>{{/if}}</p>')).toEqual(['TAG_NOT_OPENED', 'TAG_NOT_CLOSED']);
  });

  it('refuses anything but a value, an each and an if', () => {
    expect(rules('{{{raw}}}')).toEqual(['EXPRESSION_NOT_ALLOWED']);
    expect(rules('{{> partial}}')).toEqual(['EXPRESSION_NOT_ALLOWED']);
    expect(rules('{{! comment}}')).toEqual(['EXPRESSION_NOT_ALLOWED']);
    expect(rules('{{lookup a b}}')).toEqual(['EXPRESSION_NOT_ALLOWED']);
    expect(rules('{{#each lines}}x')).toEqual(['BLOCK_NOT_CLOSED']);
    expect(rules('x{{/each}}')).toEqual(['BLOCK_NOT_OPENED']);
    expect(rules('{{#if a}}x{{/each}}{{/if}}')).toEqual(['BLOCK_NOT_OPENED']);
  });

  it('refuses a stray < or {{, and checks a hostile body of 64 KiB quickly', () => {
    expect(rules('<p>a < b</p>')).toEqual(['TAG_NOT_ALLOWED']);
    expect(rules('<p>{{a</p>')).toEqual(['EXPRESSION_NOT_ALLOWED']);
    expect(rules('<p>a}}</p>')).toEqual(['EXPRESSION_NOT_ALLOWED']);
    const started = performance.now();
    for (const unit of ['a', '<a', '{{a', 'a:', '<p ']) checkTemplateBody(unit.repeat(Math.floor(MAX_TEMPLATE_BYTES / unit.length)));
    // Linear time: the five hostile bodies take milliseconds; a backtracking pattern took minutes on the first.
    expect(performance.now() - started).toBeLessThan(2_000);
  });

  it('refuses a body over 64 KiB', () => {
    expect(rules('a'.repeat(MAX_TEMPLATE_BYTES))).toEqual([]);
    expect(rules('a'.repeat(MAX_TEMPLATE_BYTES + 1))).toEqual(['TEMPLATE_TOO_LARGE']);
  });
});

describe('renderTemplate', () => {
  const data = {
    documentNo: 'INV-2026-DDW-000001',
    customer: { name: 'Tema Cold Store Ltd (SEED)' },
    lines: [
      { description: 'Goat meat, 15 kg pack', gross: 'GHS 425.60' },
      { description: 'Eggs <big> & small', gross: 'GHS 120.00' },
    ],
    tags: ['a', 'b'],
    none: [],
    zero: 0,
    flag: false,
  };

  it('fills values, walks lists with the outer scope still visible, and escapes what it inserts', () => {
    const out = renderTemplate('<h1>{{documentNo}}</h1>{{#each lines}}<row><cell>{{description}}</cell><cell>{{gross}}</cell><cell>{{documentNo}}</cell></row>{{/each}}', data);
    expect(out).toBe(
      '<h1>INV-2026-DDW-000001</h1><row><cell>Goat meat, 15 kg pack</cell><cell>GHS 425.60</cell><cell>INV-2026-DDW-000001</cell></row><row><cell>Eggs &lt;big&gt; &amp; small</cell><cell>GHS 120.00</cell><cell>INV-2026-DDW-000001</cell></row>',
    );
  });

  it('shows an if only for a present, non-empty, non-false value; a missing path is empty', () => {
    expect(renderTemplate('{{#if customer}}{{customer.name}}{{/if}}|{{#if none}}x{{/if}}|{{#if flag}}x{{/if}}|{{#if zero}}0{{/if}}|{{missing.path}}|{{customer.missing}}', data)).toBe('Tema Cold Store Ltd (SEED)|||0||');
    expect(renderTemplate('{{#each tags}}[{{this}}]{{/each}}{{#each documentNo}}x{{/each}}{{#each customer}}{{name}}{{/each}}', data)).toBe('[a][b]');
    expect(renderTemplate('{{customer}}{{zero}}{{flag}}', data)).toBe('0false');
  });

  it('refuses to render a body that breaks a rule', () => {
    expect(() => renderTemplate('<script></script>', {})).toThrow(TemplateBodyInvalidError);
  });
});

describe('layoutMarkup', () => {
  it('lays lines out in order, centring the header and footer, columns from cells', () => {
    const markup = renderTemplate(
      '<header><h1>HaKorem Farms</h1>Dodowa</header><h2>Invoice {{no}}</h2><row><cell>Goat</cell><cell>GHS 800.00</cell></row><row>Plain row</row><hr/><levies>{{#each levies}}<row><cell>{{name}}</cell><cell>{{amount}}</cell></row>{{/each}}</levies>Loose text<footer>Thank you &amp; welcome</footer>',
      { no: 'INV-1', levies: [{ name: 'VAT', amount: 'GHS 53.20' }] },
    );
    expect(layoutMarkup(markup)).toEqual([
      { cells: ['HaKorem Farms'], style: 'h1', center: true, rule: false },
      { cells: ['Dodowa'], style: 'p', center: true, rule: false },
      { cells: ['Invoice INV-1'], style: 'h2', center: false, rule: false },
      { cells: ['Goat', 'GHS 800.00'], style: 'p', center: false, rule: false },
      { cells: ['Plain row'], style: 'p', center: false, rule: false },
      { cells: [], style: 'p', center: false, rule: true },
      { cells: ['VAT', 'GHS 53.20'], style: 'p', center: false, rule: false },
      { cells: ['Loose text'], style: 'p', center: false, rule: false },
      { cells: ['Thank you & welcome'], style: 'small', center: true, rule: false },
    ]);
  });

  it('keeps text after the cells of a row as one more cell, and an empty line as a blank', () => {
    expect(layoutMarkup('<row><cell>a</cell> tail </row><p></p><small>s</small>')).toEqual([
      { cells: ['a', 'tail'], style: 'p', center: false, rule: false },
      { cells: [''], style: 'p', center: false, rule: false },
      { cells: ['s'], style: 'small', center: false, rule: false },
    ]);
    expect(rules('<p/>')).toEqual([]);
    expect(layoutMarkup('</cell><b>bold is not a layout tag</b>')).toEqual([{ cells: ['bold is not a layout tag'], style: 'p', center: false, rule: false }]);
  });
});
