import { randomUUID } from 'node:crypto';
import { ManualClock } from '@hakorem/kernel';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PUBLISHED_PATH, readYaml } from '../../../scripts/contract/generate';
import { runSeedUnits } from '../../../src/seed/run-seed';
import { seedUnits } from '../../../src/seed/seed-units';
import { createBranch, createUser, enrolAndLogin, login, relaxRateLimits, SYSTEM_PRINCIPAL, testStartTime, type RoleCode, type TestSession } from '../../support/iam';
import { registeredRoutes, VALID_BODY, VALID_QUERY, type RouteInfo } from '../../support/routes';
import { startTestApp, TEST_ORIGIN, type TestApp } from '../../support/test-app';
import { createTestDatabase, type TestDatabase } from '../../support/test-database';

/**
 * No identifier is ever a key (owner's decision 5, 2026-11-17; SC-02; ADR-0017, ADR-0035, ADR-0073, ADR-0074).
 *
 * The walk is generated: every route the application mounts is looked up in the committed contract, and every one
 * that takes an identifier (a UUID or another named key in its path, a UUID or a search `q` in its query, a UUID
 * anywhere in its body) is called over the seeded farm by each caller who must get nothing:
 *
 * - an anonymous caller, a signed-in customer and a staff member whose seeded role lacks the operation's permission:
 *   each with the id of a real record at Dodowa (or a real public ID or SKU in `q`) and again with a random one. The
 *   answer must be a refusal (401, 403 or 404 as SC-02 says) carrying nothing but the error envelope, and the same
 *   for the real and the random identifier, so knowing an identifier tells the caller nothing, not even that it exists;
 * - the Owner granted at another branch, for every operation on a Dodowa record that belongs to a branch: refused with
 *   nothing of the record in the answer.
 *
 * A route whose contract shows no identifier must be in TAKES_NO_IDENTIFIER below, so a new operation cannot escape
 * the walk by being added. The storefront's public routes and the customer's own reads are proved in their own blocks.
 */

interface ContractOperation {
  readonly operationId: string;
  readonly tags?: readonly string[];
  readonly parameters: ReadonlyArray<{ readonly name: string; readonly in: string; readonly schema?: Record<string, unknown> }>;
  readonly requestBody?: { readonly content?: Record<string, { readonly schema?: unknown }> };
}

/** Implemented operations that take no identifier at all, by their contract: nothing for this walk to try. */
const TAKES_NO_IDENTIFIER = [
  'getHealth', 'uploadFile', 'loginStaff', 'loginCustomer', 'loginInvestor', 'verifyTotp', 'refreshSession', 'logout', 'getCurrentSession', 'changePassword',
  'requestPasswordReset', 'resetPassword', 'startTotpEnrolment', 'confirmTotpEnrolment', 'stepUp', 'registerCustomer', 'verifyCustomerPhone', 'listRoles',
  'createRole', 'listPermissions', 'listApprovals', 'getBusinessProfile', 'listCategories', 'listUnitsOfMeasure', 'listSpeciesList', 'createSpecies',
  'listCustomerTiers', 'createCustomerTier', 'listBranches', 'createBranch', 'listPriceLists', 'listPromotions', 'listTaxLevies', 'createTaxLevy',
  'listTaxCategories', 'createTaxCategory', 'listTaxSchemeVersions', 'listPaymentMethods', 'listReasonCodes', 'listImportJobs', 'createExportJob',
  'listMovementTypes', 'listYieldStandards', 'listAccounts', 'listBankAccounts', 'listAccountingPeriods', 'listManualJournals', 'listPostingEventTypes',
  'listPostingRules', 'listAccountDeterminations', 'listFixedAssets', 'listDepreciationRuns', 'listDocumentTemplates', 'listDunningLevels', 'replaceDunningLevels', 'listUnmatchedPayments',
  'listSettlementReports', 'listReconciliationBreaks', 'listShopCategories', 'getShopProfile', 'createCart', 'listMyOrders', 'getMyStoreCredit',
  // B09b continued 3: one's own till PIN takes no identifier.
  'setTillPin',
];

/** Public by design, each proved in its own block below or in its module's tests (named here). */
const PUBLIC_WITH_IDENTIFIER: Readonly<Record<string, string>> = {
  getCatalogueProduct: 'this file: an unlisted product reads nothing by its slug',
  listCatalogue: 'this file: an unlisted product is found by no SKU or name',
  listDeliverySlotOptions: 'public by design: a zone’s open slots, nothing about any customer (shp/checkout tests)',
  getCart: 'this file: another guest’s cart',
  addCartLine: 'this file: another guest’s cart',
  updateCartLine: 'this file: another guest’s cart',
  removeCartLine: 'this file: another guest’s cart',
  applyCartCoupon: 'this file: another guest’s cart',
  removeCartCoupon: 'this file: another guest’s cart',
  startCheckout: 'this file: another guest’s cart',
  getCheckout: 'this file: another guest’s checkout',
  updateCheckout: 'this file: another guest’s checkout',
  placeOrder: 'this file: another guest’s checkout',
  trackOrder: 'ord/online-orders: a guessed, altered, expired or another order’s token reads nothing (ADR-0074)',
  receivePaymentWebhook: 'pay/webhooks: refused without the provider’s signature over the raw body (abuse case 5)',
  validateCoupon: 'this file: whether a code is usable now; a cart or customer id names nothing (mdm/promotions)',
  quoteDelivery: 'public by design: a zone’s fee for an area, nothing about any customer (mdm/reference-data tests)',
  submitQuoteRequest: 'quo/quotes: a product or animal id is only checked, never answered; the reply is the request number (B10)',
  viewQuoteByLink: 'quo/quotes: a replaced, expired or guessed token, the quote id and its number open nothing (CR-047, ADR-0074)',
  acceptQuoteByLink: 'quo/quotes: a replaced, expired or guessed token, the quote id and its number accept nothing (CR-047)',
  declineQuoteByLink: 'quo/quotes: only the live version’s own token declines it (CR-047)',
};

/**
 * Master data is read and kept farm-wide by the holders of its permissions, whichever branch a record names (docs/API.md,
 * MDM; ADR-0017's branch rule binds the documents of a branch, not the farm's reference data): a branch's locations,
 * delivery zones and price lists are what another branch transfers to, delivers from and sells by.
 */
const FARM_WIDE_MODULES = new Set(['mdm']);
/** Lists outside MDM that are farm-wide for their holders, each by its documented rule. */
const FARM_WIDE_LISTS: Readonly<Record<string, string>> = {
  listGrants: 'docs/API.md, IAM: reads of users and their grants are farm-wide for their holders (Owner, Manager)',
};

const REFUSAL_CODES = new Set(['UNAUTHENTICATED', 'FORBIDDEN', 'NOT_FOUND', 'STEP_UP_REQUIRED']);

let database: TestDatabase;
let api: TestApp;
let clock: ManualClock;
let routes: RouteInfo[];
let contract: Map<string, ContractOperation>;
let schemas: Record<string, unknown>;
let rolePermissions: Map<RoleCode, Set<string>>;
let ddw: string;
let owner: TestSession;
let elsewhere: TestSession;
let customer: TestSession;
const staff = new Map<RoleCode, TestSession>();
let nobody: TestSession;
/** A real identifier for each path template prefix, or null where Dodowa holds no such record. */
const realIds = new Map<string, string | null>();
const realQuery = new Map<string, string>();
const admin = () => database.pool('admin');

function contractOf(route: RouteInfo): ContractOperation {
  const operation = contract.get(route.spec!.operationId);
  if (operation === undefined) throw new Error(`${route.spec!.operationId} is mounted but not in the contract`);
  return operation;
}

/** Whether a schema reaches a property of format uuid, following $refs once each. */
function reachesUuid(schema: unknown, seen: Set<string> = new Set()): boolean {
  if (schema === null || typeof schema !== 'object') return false;
  const s = schema as Record<string, unknown>;
  if (typeof s['$ref'] === 'string') {
    const name = s['$ref'].split('/').pop()!;
    if (seen.has(name)) return false;
    seen.add(name);
    return reachesUuid(schemas[name], seen);
  }
  if (s['format'] === 'uuid') return true;
  const nested = [...((s['anyOf'] as unknown[]) ?? []), ...((s['oneOf'] as unknown[]) ?? []), ...((s['allOf'] as unknown[]) ?? []), s['items'], ...Object.values((s['properties'] as Record<string, unknown>) ?? {})];
  return nested.some((n) => reachesUuid(n, seen));
}

function parameterSchema(p: ContractOperation['parameters'][number]): Record<string, unknown> {
  const schema = p.schema ?? {};
  if (typeof schema['$ref'] === 'string') return (schemas[(schema['$ref'] as string).split('/').pop()!] as Record<string, unknown>) ?? {};
  return schema;
}

/** The identifiers an operation takes, by its contract: its path parameters, uuid or `q` query parameters, a body reaching a uuid. */
function identifiersOf(route: RouteInfo): string[] {
  const op = contractOf(route);
  const found: string[] = [];
  for (const p of op.parameters) {
    if (p.in === 'path') found.push(`path:${p.name}`);
    if (p.in === 'query' && (parameterSchema(p)['format'] === 'uuid' || p.name === 'q')) found.push(`query:${p.name}`);
  }
  if (reachesUuid(op.requestBody?.content?.['application/json']?.schema)) found.push('body');
  return found;
}

function send(route: RouteInfo, path: string, session: TestSession | null, body: object) {
  const method = route.method.toLowerCase() as 'get' | 'post' | 'put' | 'patch' | 'delete';
  let req = request(api.server)[method](path).set('Origin', TEST_ORIGIN);
  if (session !== null) req = req.set('Cookie', session.jar.header()).set('X-CSRF-Token', session.csrfToken);
  if (method === 'get') return req;
  return req.set('Idempotency-Key', randomUUID()).send(body);
}

/** The path parameters' values: a real record's id where one is known (`real`), else a random one; named keys by name. */
function pathFor(route: RouteInfo, real: boolean): string {
  const segments = route.path.split('/');
  const out: string[] = [];
  for (const segment of segments) {
    if (!segment.startsWith(':')) {
      out.push(segment);
      continue;
    }
    const name = segment.slice(1);
    const known = realIds.get(`${out.join('/')}/:${name}`) ?? null;
    if (name === 'key') out.push('pur.purchase_order.approval_limit_pesewas');
    else if (name === 'tagNo') out.push(real ? 'G-0143' : 'G-9999');
    else out.push(real && known !== null ? known : randomUUID());
  }
  return out.join('/');
}

function queryFor(route: RouteInfo, real: boolean): string {
  const operationId = route.spec!.operationId;
  const fixed = VALID_QUERY[operationId] ?? '';
  const q = realQuery.get(operationId);
  if (q === undefined) return fixed;
  const value = real ? q : operationId === 'listCustomers' ? 'cus_ZZZZZZZZZZZZZZZZ' : operationId === 'listSuppliers' ? 'sup_ZZZZZZZZZZZZZZZZ' : 'ZZZ-9999';
  return `${fixed === '' ? '?' : `${fixed}&`}q=${encodeURIComponent(value)}`;
}

/** The answer is a refusal and nothing else: the envelope only, no detail, no identifier echoed back. */
function expectNothingIn(response: request.Response, label: string, identifiers: readonly string[]): void {
  expect([401, 403, 404], `${label}: ${response.status} ${JSON.stringify(response.body).slice(0, 300)}`).toContain(response.status);
  expect(Object.keys(response.body as object), label).toEqual(['error']);
  expect(REFUSAL_CODES.has(response.body.error.code as string), `${label}: ${response.body.error.code}`).toBe(true);
  expect(response.body.error.details ?? [], label).toEqual([]);
  const text = JSON.stringify(response.body);
  for (const id of identifiers) expect(text.includes(id), `${label} echoes ${id}`).toBe(false);
}

/** Real identifiers the path carries, so the answer can be searched for them. */
function idsIn(path: string): string[] {
  return path.split('/').filter((s) => /^[0-9a-f]{8}-[0-9a-f]{4}-/.test(s));
}

/** Fills realIds: each path prefix ending in a parameter gets the first id its collection lists to Dodowa's Owner. */
async function resolveRealIds(): Promise<void> {
  const templates = [...new Set(routes.flatMap((r) => r.path.split('/').flatMap((s, i, all) => (s.startsWith(':') ? [all.slice(0, i + 1).join('/')] : []))))].sort((a, b) => a.length - b.length);
  for (const template of templates) {
    if (realIds.get(template) !== undefined && realIds.get(template) !== null) continue;
    const parameterAt = template.lastIndexOf('/:');
    const collection = template.slice(0, parameterAt);
    const list = routes.find((r) => r.method === 'GET' && r.path === collection);
    let found: string | null = null;
    if (list !== undefined && !collection.split('/').some((s) => s.startsWith(':') && realIds.get(collection.slice(0, collection.indexOf(s) + s.length)) === null)) {
      const concrete = pathFor(list, true);
      const answer = await send(list, `${concrete}${VALID_QUERY[list.spec!.operationId] ?? ''}`, owner, {});
      const first = answer.status === 200 && Array.isArray(answer.body.data) ? (answer.body.data[0] as Record<string, unknown> | undefined) : undefined;
      if (typeof first?.['id'] === 'string') found = first['id'];
    }
    realIds.set(template, found);
  }
}

/**
 * Records at Dodowa that the seeded farm does not hold, made through the API as the Dodowa Owner, so the walk has a
 * real identifier for them too: a stock take, a hold, a health event, a feed record, a draft
 * processing order and an evidence file.
 */
async function seedDodowaRecords(): Promise<void> {
  const one = async <T extends Record<string, unknown>>(sql: string, values: unknown[] = []) => (await admin().query<T>(sql, values)).rows[0]!;
  const shop = await one<{ id: string }>("SELECT l.id FROM mdm.location l WHERE l.branch_id = $1 AND l.kind = 'SHOP_FLOOR' AND l.deleted_at IS NULL ORDER BY l.code LIMIT 1", [ddw]);
  const goat = await one<{ id: string; location: string }>(
    `SELECT su.id, su.current_location_id AS location FROM inv.stock_unit su JOIN liv.animal a ON a.stock_unit_id = su.id
      WHERE su.branch_id = $1 AND su.status = 'ACTIVE' AND NOT EXISTS (SELECT 1 FROM inv.stock_hold h WHERE h.stock_unit_id = su.id) ORDER BY su.id LIMIT 1`,
    [ddw],
  );
  const feed = await one<{ id: string }>("SELECT id FROM mdm.product WHERE sku = 'FEED-0001'");
  const cold = await one<{ id: string }>("SELECT l.id FROM mdm.location l WHERE l.branch_id = $1 AND l.kind = 'COLD_ROOM' AND l.deleted_at IS NULL ORDER BY l.code LIMIT 1", [ddw]);
  const at = clock.now().toISOString();
  const day = at.slice(0, 10);
  const made: Array<[string, object]> = [
    ['/v1/stock-takes', { locationId: shop.id, scope: 'FULL' }],
    ['/v1/health-events', { kind: 'TREATMENT', stockUnitId: goat.id, occurredAt: at }],
    ['/v1/feed-consumption', { locationId: goat.location, feedProductId: feed.id, qty: '10.000', consumedOn: day }],
    ['/v1/processing-orders', { locationId: goat.location, outputLocationId: cold.id, inputs: [{ stockUnitId: goat.id, weightKg: '28.000', weightSource: 'SCALE' }] }],
    ['/v1/stock/holds', { stockUnitId: goat.id, kind: 'INVESTIGATION', note: 'Limping since Monday, kept apart' }],
  ];
  for (const [path, body] of made) {
    const answer = await request(api.server).post(path).set('Cookie', owner.jar.header()).set('X-CSRF-Token', owner.csrfToken).set('Origin', TEST_ORIGIN).set('Idempotency-Key', randomUUID()).send(body);
    expect([201, 202], `${path}: ${JSON.stringify(answer.body).slice(0, 300)}`).toContain(answer.status);
  }
  const file = await request(api.server)
    .post('/v1/files')
    .set('Cookie', owner.jar.header())
    .set('X-CSRF-Token', owner.csrfToken)
    .set('Origin', TEST_ORIGIN)
    .set('Idempotency-Key', randomUUID())
    .field('purpose', 'EVIDENCE')
    .attach('file', Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00]), 'pen.jpg');
  expect(file.status, JSON.stringify(file.body)).toBe(201);
  realIds.set('/v1/files/:id', file.body.id as string);
}

beforeAll(async () => {
  database = await createTestDatabase();
  clock = new ManualClock(testStartTime());
  await relaxRateLimits(database);
  for (const key of ['rate_limit.public.per_address_1m', 'rate_limit.checkout.per_address_10m']) {
    await database.pool('app').query(
      `INSERT INTO platform.setting (id, key, value, value_type, valid_from, description, created_by, updated_by)
       VALUES ($1, $2, '100000', 'INTEGER', now() - interval '1 day', 'Raised for a test file', $3, $3)`,
      [randomUUID(), key, SYSTEM_PRINCIPAL],
    );
  }
  api = await startTestApp(database, { clock, environment: { AUTH_ACCESS_TTL_SECONDS: '43200' } });
  await runSeedUnits(database.pool('app'), api.app, seedUnits({ SEED_STAFF_PASSWORD: `Seed-${randomUUID()}` }, { tradingDay: true }));
  routes = registeredRoutes(api.app);
  const document = readYaml(PUBLISHED_PATH) as unknown as { paths: Record<string, Record<string, ContractOperation & { parameters?: unknown[] }>>; components: Record<string, Record<string, unknown>> };
  schemas = document.components['schemas']!;
  const parameters = document.components['parameters']!;
  contract = new Map();
  for (const item of Object.values(document.paths)) {
    for (const [method, op] of Object.entries(item)) {
      if (!['get', 'post', 'put', 'patch', 'delete'].includes(method)) continue;
      const resolved = ((op.parameters ?? []) as Array<Record<string, unknown>>).map((p) => (typeof p['$ref'] === 'string' ? (parameters[(p['$ref'] as string).split('/').pop()!] as Record<string, unknown>) : p));
      contract.set(op.operationId, { ...op, parameters: resolved as unknown as ContractOperation['parameters'] });
    }
  }
  const seeded = document.components['x-seeded-roles'] as unknown as Array<{ code: RoleCode; permissions: string[] }>;
  rolePermissions = new Map(seeded.map((r) => [r.code, new Set(r.permissions)]));

  ddw = (await admin().query<{ id: string }>("SELECT id FROM mdm.branch WHERE code = 'DDW'")).rows[0]!.id;
  const tema = await createBranch(database, 'TMA');
  owner = await enrolAndLogin(api.server, await createUser(database, { name: 'Akosua Owusu', grants: [{ role: 'OWNER', branchId: ddw }] }), () => clock.now());
  elsewhere = await enrolAndLogin(api.server, await createUser(database, { name: 'Yaw Boateng', grants: [{ role: 'OWNER', branchId: tema.branchId }] }), () => clock.now());
  for (const role of ['MANAGER', 'ACCOUNTANT', 'STOREKEEPER', 'CASHIER', 'SALES', 'FARM_HAND', 'DRIVER'] as const) {
    const user = await createUser(database, { name: `Dodowa ${role.toLowerCase()}`, grants: [{ role, branchId: ddw }] });
    staff.set(role, ['MANAGER', 'ACCOUNTANT'].includes(role) ? await enrolAndLogin(api.server, user, () => clock.now()) : await login(api.server, user));
  }
  nobody = await login(api.server, await createUser(database, { name: 'Kwabena Ofori' }));
  const shopper = await createUser(database, { name: 'Efua Mensah', realm: 'CUSTOMER' });
  const own = (await admin().query<{ id: string }>("SELECT id FROM mdm.customer WHERE deleted_at IS NULL ORDER BY customer_no DESC LIMIT 1")).rows[0]!.id;
  await admin().query('UPDATE mdm.customer SET principal_id = $1, version = version + 1 WHERE id = $2', [shopper.principalId, own]);
  customer = await login(api.server, shopper);

  await seedDodowaRecords();
  await resolveRealIds();
  realQuery.set('listCustomers', (await admin().query<{ p: string }>('SELECT public_id AS p FROM mdm.customer WHERE id <> $1 AND deleted_at IS NULL ORDER BY customer_no LIMIT 1', [own])).rows[0]!.p);
  realQuery.set('listSuppliers', (await admin().query<{ p: string }>('SELECT public_id AS p FROM mdm.supplier WHERE deleted_at IS NULL ORDER BY supplier_no LIMIT 1')).rows[0]!.p);
  realQuery.set('listProducts', 'EGG-0003');
});

afterAll(async () => {
  await api?.close();
  await database?.drop();
});

/** The staff routes the walk calls: every mounted route but the public ones and the caller's own account. */
const staffRoutes = () => routes.filter((r) => r.spec!.access === 'SESSION' && r.spec!.realms.includes('STAFF') && identifiersOf(r).length > 0);

describe('no identifier is a key: the walk covers every operation that takes one (decision 5)', () => {
  it('finds every mounted operation in the contract, and each takes an identifier or is listed as taking none', () => {
    const none = routes.filter((r) => identifiersOf(r).length === 0).map((r) => r.spec!.operationId).sort();
    expect(none).toEqual([...TAKES_NO_IDENTIFIER].sort());
    const publicOnes = routes.filter((r) => r.spec!.access === 'PUBLIC' && identifiersOf(r).length > 0).map((r) => r.spec!.operationId).sort();
    expect(publicOnes.filter((o) => !(o in PUBLIC_WITH_IDENTIFIER)), 'public, unlisted').toEqual([]);
    expect(publicOnes).toEqual(Object.keys(PUBLIC_WITH_IDENTIFIER).sort());
    const others = routes.filter((r) => r.spec!.access === 'SESSION' && !r.spec!.realms.includes('STAFF') && identifiersOf(r).length > 0).map((r) => r.spec!.operationId);
    expect(others.sort()).toEqual(['getMyOrder']);
    expect(staffRoutes().length).toBeGreaterThanOrEqual(340);
  });

  it('knows a real Dodowa record for most templates, so the walk proves a real identifier gets nothing, not only a made-up one', () => {
    const known = [...realIds.values()].filter((v) => v !== null).length;
    expect(known, JSON.stringify([...realIds.entries()].filter(([, v]) => v === null).map(([k]) => k))).toBeGreaterThanOrEqual(50);
  });
});

describe('an anonymous caller gets nothing from any identifier', () => {
  it('refuses every staff operation with 401, the same for a real and a random identifier, and says nothing more', async () => {
    for (const route of staffRoutes()) {
      const body = VALID_BODY[route.spec!.operationId] ?? {};
      const realPath = pathFor(route, true);
      const real = await send(route, `${realPath}${queryFor(route, true)}`, null, body);
      const random = await send(route, `${pathFor(route, false)}${queryFor(route, false)}`, null, body);
      const label = `${route.method} ${route.path}`;
      expectNothingIn(real, label, idsIn(realPath));
      expect([real.status, real.body.error.code], label).toEqual([401, 'UNAUTHENTICATED']);
      expect([random.status, random.body.error.code], label).toEqual([real.status, real.body.error.code]);
    }
  });
});

describe('a signed-in customer gets nothing from any staff identifier', () => {
  it('refuses every staff operation (401 for another realm, 403 on a file), the same for a real and a random identifier', async () => {
    for (const route of staffRoutes()) {
      const body = VALID_BODY[route.spec!.operationId] ?? {};
      const realPath = pathFor(route, true);
      const real = await send(route, `${realPath}${queryFor(route, true)}`, customer, body);
      const random = await send(route, `${pathFor(route, false)}${queryFor(route, false)}`, customer, body);
      const label = `${route.method} ${route.path}`;
      expectNothingIn(real, label, idsIn(realPath));
      // A staff route is of another realm (401); a file route also serves customers, who hold no file permission (403).
      expect([real.status, real.body.error.code], label).toEqual(route.spec!.realms.includes('CUSTOMER') ? [403, 'FORBIDDEN'] : [401, 'UNAUTHENTICATED']);
      expect([random.status, random.body.error.code], label).toEqual([real.status, real.body.error.code]);
    }
  });
});

describe('a staff role without the permission gets nothing from any identifier', () => {
  it('refuses every permissioned operation to a Dodowa role that lacks it, with 403, the same for a real and a random identifier', async () => {
    let byRole = 0;
    for (const route of staffRoutes()) {
      const permission = route.spec!.permission;
      const lacking = permission === null ? undefined : [...staff.keys()].find((role) => !rolePermissions.get(role)!.has(permission));
      const caller = lacking === undefined ? nobody : staff.get(lacking)!;
      if (lacking !== undefined) byRole += 1;
      const body = VALID_BODY[route.spec!.operationId] ?? {};
      const realPath = pathFor(route, true);
      const real = await send(route, `${realPath}${queryFor(route, true)}`, caller, body);
      const random = await send(route, `${pathFor(route, false)}${queryFor(route, false)}`, caller, body);
      const label = `${route.method} ${route.path} as ${lacking ?? 'no grant'}`;
      expectNothingIn(real, label, idsIn(realPath));
      expect([real.status, real.body.error.code], label).toEqual([403, 'FORBIDDEN']);
      expect([random.status, random.body.error.code], label).toEqual([real.status, real.body.error.code]);
    }
    expect(byRole).toBeGreaterThanOrEqual(250);
  });
});

describe('a staff member outside the record’s branch gets nothing from its identifier', () => {
  it('refuses the Owner of another branch every operation on a Dodowa record that belongs to Dodowa', async () => {
    const scoped = new Map<string, boolean>();
    const farmWide = new Set<string>();
    let refused = 0;
    for (const route of staffRoutes()) {
      const segments = route.path.split('/');
      const first = segments.findIndex((s) => s.startsWith(':'));
      if (first < 0) continue;
      const template = segments.slice(0, first + 1).join('/');
      if (realIds.get(template) === null || realIds.get(template) === undefined) continue;
      const item = `${template.slice(0, template.lastIndexOf('/:'))}/${realIds.get(template)!}`;
      if (!scoped.has(item)) {
        const read = await request(api.server).get(item).set('Cookie', owner.jar.header());
        const branchOf = read.status === 200 ? ((read.body.branchId as string | undefined) ?? (read.body.branch as { id?: string } | undefined)?.id) : undefined;
        scoped.set(item, branchOf === ddw);
      }
      if (!scoped.get(item)) continue;
      if (FARM_WIDE_MODULES.has(contractOf(route).tags?.[0] ?? '')) {
        farmWide.add(route.spec!.operationId);
        continue;
      }
      const path = pathFor(route, true);
      const answer = await send(route, `${path}${queryFor(route, true)}`, elsewhere, VALID_BODY[route.spec!.operationId] ?? {});
      expectNothingIn(answer, `${route.method} ${route.path} from another branch`, idsIn(path));
      refused += 1;
    }
    expect([...farmWide].sort()).toEqual(['archiveLocation', 'getDeliveryZone', 'getLocation', 'updateDeliveryZone', 'updateLocation']);
    expect(refused).toBeGreaterThanOrEqual(40);
  });
});

describe('a list shows a staff member nothing of a branch their grants do not reach', () => {
  it('answers the Owner of another branch no Dodowa row on any staff list', async () => {
    const lists = routes.filter(
      (r) => r.method === 'GET' && r.spec!.access === 'SESSION' && r.spec!.realms.includes('STAFF') && !r.path.includes('/:') && !FARM_WIDE_MODULES.has(contractOf(r).tags?.[0] ?? '') && !(r.spec!.operationId in FARM_WIDE_LISTS),
    );
    let read = 0;
    for (const route of lists) {
      const mine = await send(route, `${route.path}${VALID_QUERY[route.spec!.operationId] ?? ''}`, owner, {});
      if (mine.status !== 200 || !Array.isArray(mine.body.data)) continue;
      const atDodowa = (rows: Array<Record<string, unknown>>) => rows.filter((row) => row['branchId'] === ddw || (row['branch'] as { id?: string } | undefined)?.id === ddw).length;
      if (atDodowa(mine.body.data) === 0) continue;
      read += 1;
      const theirs = await send(route, `${route.path}${VALID_QUERY[route.spec!.operationId] ?? ''}`, elsewhere, {});
      expect(theirs.status === 200 ? atDodowa(theirs.body.data) : 0, route.spec!.operationId).toBe(0);
    }
    expect(read).toBeGreaterThanOrEqual(10);
  });
});

describe('a customer’s own reads answer 404 for another customer’s record (SC-02)', () => {
  it('answers getMyOrder with another customer’s order exactly as with a made-up one, and refuses an anonymous or staff caller', async () => {
    const other = (await admin().query<{ id: string }>('SELECT id FROM mdm.customer WHERE principal_id IS NULL AND deleted_at IS NULL ORDER BY customer_no LIMIT 1')).rows[0]!.id;
    const egg = (await admin().query<{ id: string }>("SELECT id FROM mdm.product WHERE sku = 'EGG-0003'")).rows[0]!.id;
    const theirs = await request(api.server)
      .post('/v1/orders')
      .set('Cookie', staff.get('SALES')!.jar.header())
      .set('X-CSRF-Token', staff.get('SALES')!.csrfToken)
      .set('Origin', TEST_ORIGIN)
      .set('Idempotency-Key', randomUUID())
      .send({ channel: 'WHOLESALE', customerId: other, fulfilmentMode: 'COLLECTION', paymentTerms: 'COD', lines: [{ productId: egg, quantity: '1.000' }] });
    expect(theirs.status, JSON.stringify(theirs.body)).toBe(201);
    const route = routes.find((r) => r.spec!.operationId === 'getMyOrder')!;
    const real = await send(route, `/v1/me/orders/${theirs.body.id as string}`, customer, {});
    const random = await send(route, `/v1/me/orders/${randomUUID()}`, customer, {});
    expectNothingIn(real, 'getMyOrder, another customer’s', [theirs.body.id as string, theirs.body.orderNo as string]);
    expect([real.status, real.body.error.code]).toEqual([404, 'NOT_FOUND']);
    expect([random.status, random.body.error.code]).toEqual([404, 'NOT_FOUND']);
    for (const caller of [null, owner]) {
      const refused = await send(route, `/v1/me/orders/${theirs.body.id as string}`, caller, {});
      expectNothingIn(refused, 'getMyOrder, not a customer', [theirs.body.id as string]);
      expect(refused.status).toBe(401);
    }
  });
});

describe('the storefront: a guest’s cart and checkout open only with that guest’s own cookie', () => {
  interface Guest {
    readonly cartId: string;
    readonly cookie: string;
  }
  const guestWrite = (method: 'post' | 'put' | 'patch' | 'delete', path: string, guest: Guest | null, body: object = {}) => {
    const req = request(api.server)[method](path).set('Origin', TEST_ORIGIN).set('Idempotency-Key', randomUUID());
    return (guest === null ? req : req.set('Cookie', guest.cookie)).send(body);
  };
  async function newGuest(): Promise<Guest> {
    const created = await request(api.server).post('/v1/shop/carts').set('Origin', TEST_ORIGIN).set('Idempotency-Key', randomUUID());
    expect(created.status).toBe(201);
    const cookie = (created.headers['set-cookie'] as unknown as string[]).find((c) => c.startsWith('__Host-hk_guest='))!;
    return { cartId: created.body.id as string, cookie: cookie.split(';')[0]! };
  }
  const BODY: Readonly<Record<string, object>> = {
    addCartLine: { productId: randomUUID(), quantity: '1.000' },
    updateCartLine: { quantity: '2.000' },
    applyCartCoupon: { code: 'XMAS-26' },
    startCheckout: { contactName: 'Ama Serwaa Ofori', contactPhone: '+233244512876', fulfilmentMode: 'COLLECTION', paymentTerms: 'PREPAID' },
    updateCheckout: { paymentTerms: 'COD' },
    placeOrder: { paymentMethod: 'MOBILE_MONEY', payerPhone: '+233244512876', network: 'MTN' },
  };

  it('answers another guest and a caller with no cookie 404 on every cart and checkout route, exactly as for a made-up id', async () => {
    const egg = (await admin().query<{ id: string }>("SELECT id FROM mdm.product WHERE sku = 'EGG-0003'")).rows[0]!.id;
    const owner = await newGuest();
    const line = await guestWrite('post', `/v1/shop/carts/${owner.cartId}/lines`, owner, { productId: egg, quantity: '1.000' });
    expect(line.status, JSON.stringify(line.body)).toBe(200);
    const lineId = (line.body.lines as Array<{ id: string }>)[0]!.id;
    const second = await newGuest();
    expect((await guestWrite('post', `/v1/shop/carts/${second.cartId}/lines`, second, { productId: egg, quantity: '1.000' })).status).toBe(200);
    const started = await guestWrite('post', `/v1/shop/carts/${second.cartId}/checkout`, second, BODY['startCheckout']);
    expect(started.status, JSON.stringify(started.body)).toBe(201);
    const checkoutId = started.body.id as string;
    const stranger = await newGuest();
    const guestRoutes = routes.filter((r) => /^\/v1\/shop\/(carts|checkouts)\/:id/.test(r.path));
    expect(guestRoutes.map((r) => r.spec!.operationId).sort()).toEqual(
      ['addCartLine', 'applyCartCoupon', 'getCart', 'getCheckout', 'placeOrder', 'removeCartCoupon', 'removeCartLine', 'startCheckout', 'updateCartLine', 'updateCheckout'].sort(),
    );
    for (const route of guestRoutes) {
      const fill = (real: boolean) =>
        route.path.startsWith('/v1/shop/checkouts')
          ? route.path.replace(':id', real ? checkoutId : randomUUID())
          : route.path.replace(':id', real ? owner.cartId : randomUUID()).replace(':lineId', real ? lineId : randomUUID());
      const body = BODY[route.spec!.operationId] ?? {};
      for (const caller of [stranger, null]) {
        const call = (path: string) => (route.method === 'GET' ? request(api.server).get(path).set('Cookie', caller?.cookie ?? '') : guestWrite(route.method.toLowerCase() as 'post', path, caller, body));
        const realPath = fill(true);
        const real = await call(realPath);
        const random = await call(fill(false));
        const label = `${route.method} ${route.path} as ${caller === null ? 'no cookie' : 'another guest'}`;
        expectNothingIn(real, label, idsIn(realPath));
        expect([real.status, real.body.error.code], label).toEqual([404, 'NOT_FOUND']);
        expect([random.status, random.body.error.code], label).toEqual([404, 'NOT_FOUND']);
      }
    }
    expect((await request(api.server).get(`/v1/shop/carts/${owner.cartId}`).set('Cookie', owner.cookie)).body.lines).toHaveLength(1);
  });

  it('shows an unlisted product to nobody, whether asked by a slug, its id or its SKU, and finds it in no catalogue search', async () => {
    const hidden = (await admin().query<{ id: string; sku: string; name: string; slug: string | null }>("SELECT id, sku, name, seo_slug AS slug FROM mdm.product WHERE online_mode = 'HIDDEN' AND deleted_at IS NULL ORDER BY sku LIMIT 1")).rows[0]!;
    const listed = (await admin().query<{ slug: string }>('SELECT slug FROM shp.product_listing ORDER BY slug LIMIT 1')).rows[0]!.slug;
    expect((await request(api.server).get(`/v1/shop/products/${listed}`)).status).toBe(200);
    // Each way of naming the hidden product, beside a made-up name of the same form: a slug is 404 like any unknown
    // slug, and an id or a SKU is not a slug at all, refused as invalid (400) before anything is looked up.
    const pairs: Array<[string, string]> = [
      [hidden.id, randomUUID()],
      [hidden.sku, 'ZZZ-9999'],
      [hidden.sku.toLowerCase(), 'zzz-9999'],
      ...(hidden.slug === null ? [] : ([[hidden.slug, 'no-such-product']] as Array<[string, string]>)),
    ];
    for (const [asked, madeUp] of pairs) {
      const answer = await request(api.server).get(`/v1/shop/products/${encodeURIComponent(asked)}`);
      const other = await request(api.server).get(`/v1/shop/products/${encodeURIComponent(madeUp)}`);
      expect([answer.status, answer.body.error?.code], asked).toEqual([other.status, other.body.error?.code]);
      expect([400, 404], asked).toContain(answer.status);
      expect(Object.keys(answer.body as object), asked).toEqual(['error']);
      for (const id of [hidden.id, hidden.name]) expect(JSON.stringify(answer.body).includes(id), asked).toBe(false);
    }
    for (const q of [hidden.sku, hidden.name]) {
      const found = await request(api.server).get(`/v1/shop/catalogue?q=${encodeURIComponent(q)}`);
      expect(found.status).toBe(200);
      expect(JSON.stringify(found.body).includes(hidden.id), q).toBe(false);
    }
  });

  it('answers validateCoupon the same whatever customer id it is given', async () => {
    const known = (await admin().query<{ id: string }>('SELECT id FROM mdm.customer WHERE deleted_at IS NULL ORDER BY customer_no LIMIT 1')).rows[0]!.id;
    const ask = (customerId: string) => request(api.server).post('/v1/coupons/validate').set('Origin', TEST_ORIGIN).set('Idempotency-Key', randomUUID()).send({ code: 'NO-SUCH-CODE', customerId });
    const [real, random] = [await ask(known), await ask(randomUUID())];
    expect(real.status).toBe(random.status);
    expect(real.body).toEqual(random.body);
    expect(JSON.stringify(real.body).includes(known)).toBe(false);
  });
});
