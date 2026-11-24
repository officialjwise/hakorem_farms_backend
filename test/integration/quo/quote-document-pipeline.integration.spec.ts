import { createHash, randomUUID } from 'node:crypto';
import { ManualClock, toBusinessDate } from '@hakorem/kernel';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { QuoteExpiry } from '../../../src/modules/quo';
import { runAsSystem } from '../../../src/platform/context/request-context';
import { runSeedUnits } from '../../../src/seed/run-seed';
import { seedUnits } from '../../../src/seed/seed-units';
import { documentWorker, type DocumentWorker } from '../../support/documents';
import { consoleGet, consolePost, createBranch, createUser, enrolAndLogin, login, relaxRateLimits, SYSTEM_PRINCIPAL, testStartTime, type TestSession, type TestUser } from '../../support/iam';
import { SQLSTATE, sqlStateOf } from '../../support/sql-state';
import { startTestApp, TEST_ORIGIN, type TestApp } from '../../support/test-app';
import { createTestDatabase, type TestDatabase } from '../../support/test-database';

/**
 * B10 continued 5, the gate: the quote pipeline (FR-QUO-013) reconciling to listQuotes, status by status, with the
 * SRS's 4 accepted, 3 declined and 3 expired at a win rate of 40.00; a quote for stock not on hand issued subject to
 * stock, holding only what is on hand, never more (the owner, 2026-11-18, A-328), with exact quantities asserted
 * against INV's reservations; and each issued version rendered and archived once as its own revision of the quote's
 * document (FR-QUO-007, A-330), its PDF reached by a signed, expiring URL only by the link's holder and the customer.
 * The pipeline runs first, on the file's first day; the rest a day later, so the period holds only its own quotes.
 */
let database: TestDatabase;
let api: TestApp;
let clock: ManualClock;
let worker: DocumentWorker;
const sessions = new Map<string, TestSession>();
const users = new Map<string, TestUser>();
const ids = new Map<string, string>();
const id = (name: string) => ids.get(name)!;
const admin = () => database.pool('admin');
const app = () => database.pool('app');
const as = (who: string) => sessions.get(who)!;
const post = (who: string, path: string, body: object = {}, key: string = randomUUID()) => consolePost(api.server, as(who), `/v1${path}`, key).send(body);
const get = (who: string, path: string) => consoleGet(api.server, as(who), `/v1${path}`);
const publicGet = (path: string) => request(api.server).get(`/v1${path}`);
const publicPost = (path: string, body: object) => request(api.server).post(`/v1${path}`).set('Origin', TEST_ORIGIN).set('Idempotency-Key', randomUUID()).send(body);
const one = async (sql: string, values: unknown[] = []) => (await admin().query(sql, values)).rows[0]!;
const validFor = (days: number) => new Date(Math.floor(clock.now().getTime() / 86_400_000) * 86_400_000 + days * 86_400_000 + 86_399_000).toISOString();
const eggs = (crates: string, unitPricePesewas = 6_000) => ({ productId: id('eggs'), description: 'Big eggs by the crate', quantity: crates, uom: 'CRATE', priceBasis: 'PER_UNIT', unitPricePesewas });
const goats = (heads: string) => ({ productId: id('goat'), description: 'Goats, West African Dwarf, for a naming ceremony', quantity: heads, priceBasis: 'PER_HEAD', unitPricePesewas: 80_000 });
const draft = (who: string, lines: object[], extra: object = {}) =>
  post(who, '/quotes', { contactName: 'Kofi Mensah', contactPhone: '+233244512876', validUntil: validFor(7), taxInclusive: true, terms: 'Half the price as deposit (TEST)', lines, ...extra });
const issue = (who: string, versionId: string, key: string = randomUUID()) => post(who, `/quote-versions/${versionId}/issue`, { channels: ['SMS'] }, key);
async function issued(who: string, lines: object[], extra: object = {}) {
  const made = await draft(who, lines, extra);
  expect(made.status, JSON.stringify(made.body)).toBe(201);
  const done = await issue(who, made.body.currentVersion.id);
  expect(done.status, JSON.stringify(done.body)).toBe(200);
  return { quoteId: made.body.id as string, versionId: made.body.currentVersion.id as string, token: done.body.acceptanceLinkToken as string, version: done.body };
}
async function heldBy(holderId: string): Promise<string> {
  return (await one("SELECT COALESCE(sum(qty), 0)::numeric(14,3)::text AS qty FROM inv.stock_reservation WHERE holder_document_id = $1 AND status = 'ACTIVE'", [holderId]))['qty'] as string;
}
let start: Date;
/** The file's first business day, and the days after it (Africa/Accra is UTC). */
const day = (offset: number) => toBusinessDate(new Date(start.getTime() + offset * 86_400_000));

beforeAll(async () => {
  database = await createTestDatabase();
  start = testStartTime();
  clock = new ManualClock(start);
  await relaxRateLimits(database);
  api = await startTestApp(database, { clock });
  await runSeedUnits(app(), api.app, seedUnits({ SEED_STAFF_PASSWORD: `Seed-${randomUUID()}` }));
  worker = documentWorker(api, database, clock);
  await worker.settle();
  const branchId = (await one("SELECT id FROM mdm.branch WHERE code = 'DDW'"))['id'] as string;
  for (const [name, sku] of [['goat', 'LIV-0004'], ['eggs', 'EGG-0003']] as const) ids.set(name, (await one('SELECT id FROM mdm.product WHERE sku = $1', [sku]))['id'] as string);
  ids.set('G-0142', (await one("SELECT id FROM inv.stock_unit WHERE identifier = 'G-0142'"))['id'] as string);
  const tema = await createBranch(database, 'TMA');
  const people: [string, string, string, boolean, string?][] = [
    ['manager', 'Akosua Boateng', 'MANAGER', true],
    ['accountant', 'Yaw Agyeman', 'ACCOUNTANT', true],
    ['sales', 'Esi Appiah', 'SALES', false],
    ['sales2', 'Kojo Antwi', 'SALES', false],
    ['cashier', 'Adwoa Darko', 'CASHIER', false],
    ['storekeeper', 'Kwesi Ofori', 'STOREKEEPER', false],
    ['temaOwner', 'Yaa Asantewaa', 'OWNER', true, tema.branchId],
  ];
  for (const [who, name, role, privileged, at] of people) {
    const user = await createUser(database, { name, grants: [{ role: role as 'OWNER', branchId: at ?? branchId }] });
    users.set(who, user);
    sessions.set(who, privileged ? await enrolAndLogin(api.server, user, () => clock.now()) : await login(api.server, user));
  }
  for (const [who, name, customerNo] of [['buyer', 'Abena Kyei', 'C-00002'], ['otherBuyer', 'Kojo Badu', 'C-00003']] as const) {
    const user = await createUser(database, { name, realm: 'CUSTOMER' });
    users.set(who, user);
    const customer = (await one('SELECT id FROM mdm.customer WHERE customer_no = $1', [customerNo]))['id'] as string;
    await admin().query('UPDATE mdm.customer SET principal_id = $1, version = version + 1 WHERE id = $2', [user.principalId, customer]);
    ids.set(`${who}Customer`, customer);
    sessions.set(who, await login(api.server, user));
  }
});

afterAll(async () => {
  await api?.close();
  await database?.drop();
});

describe('the quote pipeline reconciles to listQuotes (FR-QUO-013, the gate)', () => {
  it("gives Kojo Antwi's 4 accepted, 3 declined and 3 expired a win rate of 40.00, by salesperson and by product line, status by status equal to listQuotes", async () => {
    // Kojo's ten closed quotes and two open ones, on day 0. Three are valid for two minutes only.
    const accepted = [];
    for (let i = 0; i < 4; i += 1) accepted.push(await issued('sales2', [goats('2.000')]));
    const declined = [];
    for (let i = 0; i < 3; i += 1) declined.push(await issued('sales2', [eggs('1.000')]));
    const expiring = [];
    for (let i = 0; i < 3; i += 1) expiring.push(await issued('sales2', [eggs('1.000')], { validUntil: new Date(clock.now().getTime() + 120_000).toISOString() }));
    const open = [await issued('sales2', [goats('1.000')]), await issued('sales2', [eggs('2.000')])];
    // Esi's one open quote, a draft and a withdrawn quote: the draft and the withdrawn one are not in the pipeline.
    await issued('sales', [eggs('1.000')]);
    await draft('sales', [eggs('1.000')]);
    const withdrawn = await issued('sales', [eggs('1.000')]);
    expect((await post('sales', `/quotes/${withdrawn.quoteId}/cancel`, { reason: 'Buyer went elsewhere (TEST)' })).status).toBe(200);
    for (const q of accepted) {
      const r = await post('sales2', `/quotes/${q.quoteId}/record-acceptance`, { method: 'PHONE_CONFIRMED', acceptedName: 'Kofi Mensah', note: 'Confirmed by phone (TEST)' });
      expect(r.status, JSON.stringify(r.body)).toBe(200);
    }
    for (const q of declined) expect((await post('sales2', `/quotes/${q.quoteId}/decline`, { reason: 'Price too high (TEST)' })).status).toBe(200);
    // Esi's accepted egg quote, converted: still accepted, and converted.
    const toConvert = await issued('sales', [eggs('1.000')]);
    await post('sales', `/quotes/${toConvert.quoteId}/record-acceptance`, { method: 'IN_PERSON', acceptedName: 'Kofi Mensah', note: 'Signed at the gate (TEST)' });
    expect((await post('sales', `/quotes/${toConvert.quoteId}/convert`, { fulfilmentMode: 'COLLECTION', paymentTerms: 'COD' })).status).toBe(201);
    clock.advanceBy(180_000);
    const expired = await runAsSystem({ principalId: SYSTEM_PRINCIPAL, displayName: 'Scheduler' }, randomUUID(), () => api.app.get(QuoteExpiry).run({ kind: 'SYSTEM', principalId: SYSTEM_PRINCIPAL }));
    expect(expired.sort()).toEqual(expiring.map((q) => q.quoteId).sort());

    // `/quotes/pipeline` is the pipeline, never a quote's id.
    const bySales = await get('manager', `/quotes/pipeline?from=${day(0)}&to=${day(0)}&groupBy=SALESPERSON`);
    expect(bySales.status, JSON.stringify(bySales.body)).toBe(200);
    const gross = async (q: { quoteId: string }) => Number((await get('manager', `/quotes/${q.quoteId}`)).body.currentVersion.grossPesewas);
    const sum = async (qs: { quoteId: string }[]) => (await Promise.all(qs.map(gross))).reduce((a, b) => a + b, 0);
    const kojo = bySales.body.data.find((r: { group: { label: string } }) => r.group.label === 'Kojo Antwi');
    // The SRS's acceptance: of 10 closed quotes, 4 accepted, 3 declined and 3 expired, the win rate is 40.00.
    expect(kojo).toEqual({
      group: { id: users.get('sales2')!.principalId, label: 'Kojo Antwi' },
      issued: 12,
      accepted: 4,
      declined: 3,
      expired: 3,
      converted: 0,
      winRatePercent: '40.00',
      issuedValuePesewas: await sum([...accepted, ...declined, ...expiring, ...open]),
      wonValuePesewas: await sum(accepted),
    });
    // Esi's: one open, one converted (accepted first): 1 of 1 closed; the draft and the withdrawn quote are not counted.
    const esiRow = bySales.body.data.find((r: { group: { label: string } }) => r.group.label === 'Esi Appiah');
    expect([esiRow.issued, esiRow.accepted, esiRow.converted, esiRow.winRatePercent, esiRow.wonValuePesewas]).toEqual([2, 1, 1, '100.00', await gross(toConvert)]);
    expect(bySales.body.data.map((r: { group: { label: string } }) => r.group.label)).toEqual(['Esi Appiah', 'Kojo Antwi']);
    expect(bySales.body.currency).toBe('GHS');


    // Reconciliation: each status's count equals the rows listQuotes answers for the same instants and branch.
    const instants = `from=${day(0)}T00:00:00.000Z&to=${day(1)}T00:00:00.000Z`;
    const listed = async (status: string) => {
      let n = 0;
      let cursor: string | null = null;
      do {
        const page: { body: { data: unknown[]; page: { nextCursor: string | null } } } = await get('manager', `/quotes?status=${status}&${instants}&limit=100${cursor === null ? '' : `&cursor=${encodeURIComponent(cursor)}`}`);
        n += page.body.data.length;
        cursor = page.body.page.nextCursor;
      } while (cursor !== null);
      return n;
    };
    const total = (key: string) => bySales.body.data.reduce((a: number, r: Record<string, number>) => a + r[key]!, 0);
    const counts = Object.fromEntries(await Promise.all(['ISSUED', 'ACCEPTED', 'DECLINED', 'EXPIRED', 'CONVERTED', 'DRAFT', 'CANCELLED'].map(async (s) => [s, await listed(s)])));
    expect(total('issued')).toBe(counts['ISSUED'] + counts['ACCEPTED'] + counts['DECLINED'] + counts['EXPIRED'] + counts['CONVERTED']);
    expect([total('accepted'), total('declined'), total('expired'), total('converted')]).toEqual([counts['ACCEPTED'] + counts['CONVERTED'], counts['DECLINED'], counts['EXPIRED'], counts['CONVERTED']]);
    // Esi's draft and the seed's (farm-quo), and the withdrawn quote: in listQuotes, never in the pipeline.
    expect([counts['DRAFT'], counts['CANCELLED']]).toEqual([2, 1]);
    expect(total('issued')).toBe(14);

    // By product line: goats and eggs each their own row, reconciling to the same totals.
    const byLine = await get('sales', `/quotes/pipeline?from=${day(0)}&to=${day(0)}&groupBy=PRODUCT_LINE`);
    expect(byLine.status, JSON.stringify(byLine.body)).toBe(200);
    expect(byLine.body.data.every((r: { group: { id: string | null } }) => r.group.id === null)).toBe(true);
    expect(byLine.body.data.reduce((a: number, r: { issued: number }) => a + r.issued, 0)).toBe(14);
    const goatRow = byLine.body.data.find((r: { issued: number; accepted: number }) => r.issued === 5);
    expect([goatRow.accepted, goatRow.declined, goatRow.expired, goatRow.winRatePercent]).toEqual([4, 0, 0, '100.00']);
    const eggRow = byLine.body.data.find((r: { issued: number }) => r.issued === 9);
    expect([eggRow.accepted, eggRow.declined, eggRow.expired, eggRow.converted, eggRow.winRatePercent]).toEqual([1, 3, 3, 1, '14.29']);

    // Paged by a cursor bound to the caller and the filter.
    const first = await get('manager', `/quotes/pipeline?from=${day(0)}&to=${day(0)}&groupBy=SALESPERSON&limit=1`);
    expect([first.body.data.length, first.body.page.hasMore]).toEqual([1, true]);
    const next = await get('manager', `/quotes/pipeline?from=${day(0)}&to=${day(0)}&groupBy=SALESPERSON&limit=1&cursor=${encodeURIComponent(first.body.page.nextCursor)}`);
    expect([next.body.data[0].group.label, next.body.page.hasMore]).toEqual(['Kojo Antwi', false]);
    expect((await get('sales', `/quotes/pipeline?from=${day(0)}&to=${day(0)}&groupBy=SALESPERSON&limit=1&cursor=${encodeURIComponent(first.body.page.nextCursor)}`)).status).toBe(400);
    // A period with nothing in it, and one that ends before it starts.
    expect((await get('manager', `/quotes/pipeline?from=${day(1)}&to=${day(1)}&groupBy=SALESPERSON`)).body.data).toEqual([]);
    const backwards = await get('manager', `/quotes/pipeline?from=${day(1)}&to=${day(0)}&groupBy=SALESPERSON`);
    expect([backwards.status, backwards.body.error?.details?.[0]?.code]).toEqual([400, 'PERIOD_ENDS_BEFORE_IT_STARTS']);
  });

  it("refuses the Cashier, the Storekeeper and the Accountant, shows another branch's Owner nothing of Dodowa, and needs a staff session", async () => {
    const path = `/quotes/pipeline?from=${day(0)}&to=${day(0)}&groupBy=SALESPERSON`;
    for (const who of ['cashier', 'storekeeper', 'accountant']) expect([who, (await get(who, path)).status]).toEqual([who, 403]);
    const tema = await get('temaOwner', path);
    expect([tema.status, tema.body.data]).toEqual([200, []]);
    expect((await get('buyer', path)).status).toBe(401);
    expect((await publicGet(path)).status).toBe(401);
  });
});

describe('a quote for stock not on hand is issued subject to stock, holding only what is on hand (the owner, 2026-11-18, A-328)', () => {
  it('fully, partly and not on hand: exact quantities held and shown, never more than is there, and never refused', async () => {
    // Fully on hand: one crate, 30 eggs held; what was there is the eggs' whole promisable stock.
    const full = await issued('sales', [eggs('1.000')]);
    const fullLine = full.version.lines[0];
    expect([full.version.subjectToStock, fullLine.subjectToStock, fullLine.baseQuantity, fullLine.heldQuantity]).toEqual([false, false, '30.000', '30.000']);
    expect(await heldBy(full.quoteId)).toBe('30.000');
    const there = Number(fullLine.availableQuantity);
    expect(there).toBeGreaterThan(60);
    // Partly on hand: 1,000 crates (30,000 eggs) hold all that is left, exactly, and no more.
    const left = (there - 30).toFixed(3);
    const part = await issued('sales', [eggs('1000.000')]);
    const partLine = part.version.lines[0];
    expect([part.version.subjectToStock, partLine.subjectToStock, partLine.baseQuantity, partLine.availableQuantity, partLine.heldQuantity]).toEqual([true, true, '30000.000', left, left]);
    expect(await heldBy(part.quoteId)).toBe(left);
    // Not on hand: two crates with nothing left hold nothing, issued all the same (LOUD on 2.12.0: it was STOCK_SHORT).
    const none = await issued('sales', [eggs('2.000')]);
    expect([none.version.subjectToStock, none.version.lines[0].availableQuantity, none.version.lines[0].heldQuantity]).toEqual([true, '0.000', '0.000']);
    expect(await heldBy(none.quoteId)).toBe('0.000');
    // The pipeline's goat quotes hold every goat now (B11u, A-351: a line of animals holds its count at issue, and an
    // accepted quote keeps its hold, A-310 (b)); withdrawn, they give the goats back.
    const holders = await admin().query<{ id: string }>("SELECT DISTINCT r.holder_document_id AS id FROM inv.stock_reservation r JOIN quo.quote q ON q.id = r.holder_document_id WHERE r.status = 'ACTIVE' AND r.product_id = $1", [id('goat')]);
    for (const h of holders.rows) expect((await post('manager', `/quotes/${h.id}/cancel`, { reason: 'Goats needed for another buyer (TEST)' })).status).toBe(200);
    // A named animal already held by another quote: issued subject to stock, holding nothing; the first keeps it.
    const named = { productId: id('goat'), stockUnitId: id('G-0142'), description: 'Goat G-0142', quantity: '1.000', priceBasis: 'PER_HEAD', unitPricePesewas: 90_000 };
    const firstGoat = await issued('sales', [named]);
    expect([firstGoat.version.subjectToStock, firstGoat.version.lines[0].heldQuantity, await heldBy(firstGoat.quoteId)]).toEqual([false, '1.000', '1.000']);
    const rival = await issued('sales', [named]);
    expect([rival.version.subjectToStock, rival.version.lines[0].availableQuantity, rival.version.lines[0].heldQuantity, await heldBy(rival.quoteId)]).toEqual([true, '0.000', '0.000', '0.000']);
    // Animals the line does not name are held by count, two of the three goats still free (the owner, 2026-11-23, B11u,
    // A-351; this was A-309 (f)'s "held by nobody").
    const herd = await issued('sales', [goats('2.000')]);
    expect([herd.version.subjectToStock, herd.version.lines[0].availableQuantity, herd.version.lines[0].heldQuantity, await heldBy(herd.quoteId)]).toEqual([false, '3.000', '2.000', '2.000']);
    // The recorded rows match INV's reservations, and the buyer sees the flag, never the farm's stock level.
    const rows = await admin().query('SELECT s.available_qty::text AS a, s.held_qty::text AS h FROM quo.quote_line_stock s WHERE s.quote_version_id = $1', [part.versionId]);
    expect(rows.rows).toEqual([{ a: left, h: left }]);
    const shown = await publicGet(`/shop/quotes/${part.token}`);
    expect([shown.status, shown.body.subjectToStock, shown.body.lines[0].subjectToStock]).toEqual([200, true, true]);
    expect(JSON.stringify(shown.body)).not.toContain(left);
    const shownFull = await publicGet(`/shop/quotes/${full.token}`);
    expect([shownFull.body.subjectToStock, shownFull.body.lines[0].subjectToStock]).toEqual([false, false]);
    // A replay answers the same stock, held once.
    const key = randomUUID();
    const again = await draft('sales', [eggs('3.000')]);
    const a = await issue('sales', again.body.currentVersion.id, key);
    const b = await issue('sales', again.body.currentVersion.id, key);
    expect([a.status, b.status, b.body.lines[0].heldQuantity, await heldBy(again.body.id)]).toEqual([200, 200, '0.000', '0.000']);
    expect((await admin().query('SELECT 1 FROM quo.quote_line_stock WHERE quote_version_id = $1', [again.body.currentVersion.id])).rows).toHaveLength(1);
  });

  it('is held by the database: no row above what was there, above the line, for another version or after issue; never changed', async () => {
    const q = await issued('sales', [eggs('1.000')]);
    const line = (await one('SELECT id, quote_version_id FROM quo.quote_line WHERE quote_version_id = $1', [q.versionId])) as { id: string; quote_version_id: string };
    const actor = SYSTEM_PRINCIPAL;
    const insert = (lineId: string, versionId: string, available: string, held: string) =>
      admin().query('INSERT INTO quo.quote_line_stock (id, quote_line_id, quote_version_id, available_qty, held_qty, recorded_at, actor_id) VALUES ($1, $2, $3, $4, $5, now(), $6)', [randomUUID(), lineId, versionId, available, held, actor]);
    const d = await draft('sales', [eggs('1.000')]);
    const dLine = (await one('SELECT id FROM quo.quote_line WHERE quote_version_id = $1', [d.body.currentVersion.id]))['id'] as string;
    expect(await sqlStateOf(insert(dLine, d.body.currentVersion.id, '10.000', '11.000'))).toBe(SQLSTATE.checkViolation);
    expect(await sqlStateOf(insert(dLine, d.body.currentVersion.id, '100.000', '31.000'))).toBe(SQLSTATE.documentFrozen);
    expect(await sqlStateOf(insert(dLine, q.versionId, '100.000', '30.000'))).toBe(SQLSTATE.documentFrozen);
    expect(await sqlStateOf(insert(line.id, line.quote_version_id, '100.000', '30.000'))).toBe(SQLSTATE.documentFrozen);
    // Once per line: a draft's line takes one row, never two.
    expect(await sqlStateOf(insert(dLine, d.body.currentVersion.id, '100.000', '30.000'))).toBeUndefined();
    expect(await sqlStateOf(insert(dLine, d.body.currentVersion.id, '100.000', '30.000'))).toBe(SQLSTATE.uniqueViolation);
    expect(await sqlStateOf(app().query('UPDATE quo.quote_line_stock SET held_qty = 0 WHERE quote_version_id = $1', [q.versionId]))).toBe(SQLSTATE.insufficientPrivilege);
    expect(await sqlStateOf(admin().query('UPDATE quo.quote_line_stock SET held_qty = 0 WHERE quote_version_id = $1', [q.versionId]))).toBe(SQLSTATE.ledgerImmutable);
    expect(await sqlStateOf(admin().query('DELETE FROM quo.quote_line_stock WHERE quote_version_id = $1', [q.versionId]))).toBe(SQLSTATE.ledgerImmutable);
  });
});

describe("each issued version is rendered and archived once, its PDF signed for the link's holder and the customer (FR-QUO-007, A-330)", () => {
  it('archives version 1 and version 2 as revisions 1 and 2, never again on a replay or a further link, and links each version to its own', async () => {
    const key = randomUUID();
    const made = await draft('sales', [eggs('1.000')], { customerId: id('buyerCustomer') });
    const first = await issue('sales', made.body.currentVersion.id, key);
    expect(first.status).toBe(200);
    expect(first.body.documentId).toBeNull();
    await issue('sales', made.body.currentVersion.id, key); // a replay
    await issue('sales', made.body.currentVersion.id); // a further link
    await worker.settle();
    const v1 = (await get('sales', `/quotes/${made.body.id}`)).body.currentVersion;
    const archived = await admin().query<{ id: string; revision: number; doc_type: string; document_no: string; sha256: Buffer; render_data: Record<string, unknown> }>(
      'SELECT id, revision, doc_type, document_no, sha256, render_data FROM doc.archived_document WHERE business_document_id = $1 ORDER BY revision',
      [made.body.id],
    );
    expect(archived.rows.map((r) => [r.revision, r.doc_type, r.document_no])).toEqual([[1, 'QUOTE', made.body.quoteNo]]);
    expect(v1.documentId).toBe(archived.rows[0]!.id);
    expect(archived.rows[0]!.render_data).toMatchObject({ quoteNo: made.body.quoteNo, versionNo: 1, net: 'GHS 60.00', gross: 'GHS 60.00', subjectToStock: true });
    // Every egg is held by the quotes above by now, so this version is printed subject to stock, as its line is.
    expect((archived.rows[0]!.render_data['lines'] as { subjectToStock: boolean }[]).map((l) => l.subjectToStock)).toEqual([true]);
    // The PDF in the private archive, under the quote's number (DOC's own tests prove its bytes hash to the SHA-256).
    const file = await one('SELECT f.original_name, f.purpose FROM doc.archived_document a JOIN platform.stored_file f ON f.id = a.file_id WHERE a.id = $1', [v1.documentId]);
    expect([file['original_name'], file['purpose']]).toEqual([`${made.body.quoteNo}.pdf`, 'ARCHIVE']);
    // Version 2 is its own revision; version 1 keeps its document.
    const revised = await post('sales', `/quotes/${made.body.id}/versions`, { changeNote: 'Revised terms (TEST)' });
    expect(revised.status, JSON.stringify(revised.body)).toBe(201);
    const v2Draft = (await get('sales', `/quotes/${made.body.id}/versions`)).body.data.find((v: { versionNo: number }) => v.versionNo === 2);
    const v2 = await issue('sales', v2Draft.id);
    expect(v2.status, JSON.stringify(v2.body)).toBe(200);
    await worker.settle();
    const both = await admin().query<{ revision: number }>('SELECT revision FROM doc.archived_document WHERE business_document_id = $1 ORDER BY revision', [made.body.id]);
    expect(both.rows.map((r) => r.revision)).toEqual([1, 2]);
    const versions = (await get('sales', `/quotes/${made.body.id}/versions`)).body.data as { versionNo: number; documentId: string }[];
    const docOf = async (n: number) => (await one('SELECT id FROM doc.archived_document WHERE business_document_id = $1 AND revision = $2', [made.body.id, n]))['id'];
    expect(versions.map((v) => [v.versionNo, v.documentId]).sort()).toEqual([
      [1, await docOf(1)],
      [2, await docOf(2)],
    ]);
    // The archive is never rewritten; the version's document is set once.
    expect(await sqlStateOf(admin().query('UPDATE quo.quote_version SET archived_document_id = $2 WHERE id = $1', [made.body.currentVersion.id, await docOf(2)]))).toBe(SQLSTATE.documentFrozen);
    ids.set('docQuote', made.body.id);
    ids.set('docToken', v2.body.acceptanceLinkToken);
  });

  it("answers documentUrl to the link's holder and in listMyQuotes, signed and logged, and to nobody else", async () => {
    const shown = await publicGet(`/shop/quotes/${id('docToken')}`);
    expect(shown.status, JSON.stringify(shown.body)).toBe(200);
    expect(shown.body.documentUrl).toMatch(/^https?:\/\/.+(X-Amz-Signature|Signature)=/);
    const mine = await consoleGet(api.server, as('buyer'), '/v1/me/quotes');
    const listed = mine.body.data.find((q: { quoteNo: string }) => q.quoteNo === shown.body.quoteNo);
    expect(listed.documentUrl).toMatch(/^https?:\/\//);
    const v2Doc = (await one('SELECT archived_document_id AS d FROM quo.quote_version WHERE quote_id = $1 AND version_no = 2', [id('docQuote')]))['d'];
    const logged = await admin().query<{ purpose: string; actor_id: string }>(
      "SELECT l.purpose, l.actor_id FROM platform.file_access_log l JOIN doc.archived_document a ON a.file_id = l.file_id WHERE a.id = $1 AND l.purpose = 'quo.quote.document' ORDER BY l.recorded_at",
      [v2Doc],
    );
    expect(logged.rows.map((r) => r.actor_id)).toEqual(['01900000-0000-7000-8000-000000000006', users.get('buyer')!.principalId]);
    // Another customer's list holds none of it; a guessed token and the quote's id open nothing.
    const other = await consoleGet(api.server, as('otherBuyer'), '/v1/me/quotes');
    expect(JSON.stringify(other.body)).not.toContain(shown.body.quoteNo);
    expect((await publicGet(`/shop/quotes/qte_${createHash('sha256').update('guess').digest('base64url')}`)).status).toBe(404);
    expect((await publicGet(`/shop/quotes/${id('docQuote')}`)).status).toBe(404);
    // The token itself is in no stored answer, render data or archive row.
    const leaks = await one(
      `SELECT (SELECT count(*) FROM doc.archived_document a WHERE a.render_data::text LIKE '%' || $1 || '%')
            + (SELECT count(*) FROM doc.render_job j WHERE j.render_data::text LIKE '%' || $1 || '%')
            + (SELECT count(*) FROM platform.outbox_message o WHERE o.payload::text LIKE '%' || $1 || '%')::int AS n`,
      [id('docToken').slice(4)],
    );
    expect(Number(leaks['n'])).toBe(0);
    // A quote whose rendering has not happened yet answers null, not a broken link; nor does one archived but not yet
    // passed by the scan (FR-DOC-001): only then is it signed.
    const fresh = await issued('sales', [eggs('1.000')]);
    expect((await publicGet(`/shop/quotes/${fresh.token}`)).body.documentUrl).toBeNull();
    for (let pass = 0; pass < 5; pass += 1) if ((await worker.dispatch()).delivered === 0) break;
    const unscanned = await one('SELECT v.archived_document_id AS d, f.scan_status AS s FROM quo.quote_version v JOIN doc.archived_document a ON a.id = v.archived_document_id JOIN platform.stored_file f ON f.id = a.file_id WHERE v.id = $1', [fresh.versionId]);
    expect([typeof unscanned['d'], unscanned['s']]).toEqual(['string', 'PENDING']);
    expect((await publicGet(`/shop/quotes/${fresh.token}`)).body.documentUrl).toBeNull();
    await worker.scan();
    expect((await publicGet(`/shop/quotes/${fresh.token}`)).body.documentUrl).toMatch(/^https?:\/\//);
    const accepted = await publicPost(`/shop/quotes/${fresh.token}/accept`, { acceptedName: 'Kofi Mensah' });
    expect(accepted.status).toBe(200);
  });
});
