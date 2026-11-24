import { describe, expect, it } from 'vitest';
import { judgeTemplate, render } from './templates';
import { LINK_PLACEHOLDER, linkDataOf, linkKindOf, linkUrl, withLink } from './links';

describe('a link a message carries is filled in at send, never stored (ADR-0074, ADR-0096, B11 continued 12)', () => {
  it('names the record kind whose owning module makes the link, for the codes that carry one', () => {
    expect(linkKindOf('ORDER_TRACKING')).toBe('TRACKING');
    expect(linkKindOf('SALE_RECEIPT')).toBe('RECEIPT');
    expect(linkKindOf('CART_REMINDER')).toBe('CART');
    expect(linkKindOf('DOCUMENT_SENT')).toBe('DOCUMENT');
    expect(linkKindOf('REMITTANCE_ADVICE')).toBe('DOCUMENT');
    expect(linkKindOf('ORDER_DISPATCHED')).toBeNull();
  });

  it('renders the stored text with the placeholder kept, so the row holds no link and no token', () => {
    const data = linkDataOf('ORDER_TRACKING', { orderNo: 'SO-2026-000142' });
    const stored = render('HaKorem Farms: follow order {{orderNo}} at {{link}}', data);
    expect(stored).toBe(`HaKorem Farms: follow order SO-2026-000142 at ${LINK_PLACEHOLDER}`);
    expect(linkDataOf('ORDER_DISPATCHED', { orderNo: 'SO-1' })).toEqual({ orderNo: 'SO-1' });
  });

  it('fills every placeholder with the link made now, and leaves a text without one as it is', () => {
    expect(withLink(`a ${LINK_PLACEHOLDER} b ${LINK_PLACEHOLDER}`, 'https://shop.test/track/trk_x')).toBe('a https://shop.test/track/trk_x b https://shop.test/track/trk_x');
    expect(withLink('no link here', 'https://shop.test/r/x')).toBe('no link here');
  });

  it('builds each kind under the shop address, without a trailing slash doubling, the cart with no token', () => {
    expect(linkUrl('TRACKING', 'https://shop.test/', 'trk_abc')).toBe('https://shop.test/track/trk_abc');
    expect(linkUrl('RECEIPT', 'https://shop.test', 'tok')).toBe('https://shop.test/r/tok');
    expect(linkUrl('DOCUMENT', 'https://shop.test/base', 'doc_abc')).toBe('https://shop.test/base/d/doc_abc');
    expect(linkUrl('CART', 'https://shop.test//', null)).toBe('https://shop.test/cart');
    expect(() => linkUrl('TRACKING', 'https://shop.test', null)).toThrow(RangeError);
  });

  it('lets a template name the link merge field but still refuses a link typed into it (abuse case 57)', () => {
    const draft = { code: 'ORDER_TRACKING', channel: 'SMS' as const, category: 'TRANSACTIONAL' as const, subject: null, providerTemplateRef: null };
    expect(judgeTemplate({ ...draft, body: 'Follow {{orderNo}}: {{link}}' }).ok).toBe(true);
    expect(judgeTemplate({ ...draft, body: 'Follow {{orderNo}}: https://evil.example/{{link}}' }).ok).toBe(false);
    expect(judgeTemplate({ ...draft, code: 'ORDER_DISPATCHED', body: 'Sent {{orderNo}}: {{link}}' }).ok).toBe(false);
  });
});
