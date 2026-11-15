import { randomUUID } from 'node:crypto';
import { ManualClock } from '@hakorem/kernel';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { RequestMethod } from '@nestjs/common';
import { ModulesContainer } from '@nestjs/core';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { OPERATION_METADATA, type OperationSpec } from '../../../src/platform/http/operation';
import {
  consoleGet,
  consolePost,
  createBranch,
  createUser,
  enrolAndLogin,
  login,
  relaxRateLimits,
  testStartTime,
  type RoleCode,
  type TestBranch,
} from '../../support/iam';
import { startTestApp, TEST_ORIGIN, type TestApp } from '../../support/test-app';
import { createTestDatabase, type TestDatabase } from '../../support/test-database';

interface RouteInfo {
  readonly method: string;
  readonly path: string;
  readonly handler: string;
  readonly spec: OperationSpec | undefined;
}

let database: TestDatabase;
let api: TestApp;
let clock: ManualClock;
let dodowa: TestBranch;
let routes: RouteInfo[];

/** Every route of every controller the application mounted, with the operation it declares. */
function registeredRoutes(): RouteInfo[] {
  const found: RouteInfo[] = [];
  for (const module of api.app.get(ModulesContainer).values()) {
    for (const wrapper of module.controllers.values()) {
      const type = wrapper.metatype as (new (...args: never[]) => object) | null;
      if (type === null) continue;
      const base = String(Reflect.getMetadata(PATH_METADATA, type) ?? '');
      for (const name of Object.getOwnPropertyNames(type.prototype)) {
        const handler = (type.prototype as Record<string, unknown>)[name];
        if (name === 'constructor' || typeof handler !== 'function' || Reflect.getMetadata(PATH_METADATA, handler) === undefined) continue;
        const method = RequestMethod[Reflect.getMetadata(METHOD_METADATA, handler) as number]!;
        const path = `/v1/${[base, String(Reflect.getMetadata(PATH_METADATA, handler))].filter((p) => p !== '' && p !== '/').join('/')}`.replace(/\/+/g, '/');
        found.push({ method, path, handler: `${type.name}.${name}`, spec: Reflect.getMetadata(OPERATION_METADATA, handler) as OperationSpec | undefined });
      }
    }
  }
  return found;
}

/** A body that passes validation for each state-changing operation, so the refusal seen is the permission's. */
const VALID_BODY: Readonly<Record<string, object>> = {
  createProduct: { sku: 'MEAT-GOAT-5KG', name: 'Goat meat, 5 kg pack', categoryId: randomUUID(), stockPolicy: 'CATCH_WEIGHT', baseUom: 'KG', saleUom: 'PACK', onlineMode: 'LISTED' },
  revokeSession: { reason: 'Tablet left unattended overnight' },
  createUser: { displayName: 'Kojo Asante', email: 'kojo.asante@hakoremfarms.test', realm: 'STAFF', grants: [] },
  updateUser: { version: 1, displayName: 'Kojo Asante' },
  disableUser: { reason: 'Left the business' },
  enableUser: { reason: 'Came back' },
  unlockUser: { reason: 'Forgot the password' },
  resetUserPassword: { reason: 'Lost the password' },
  createGrant: { principalId: randomUUID(), roleId: randomUUID(), branchId: randomUUID() },
  revokeGrant: { reason: 'Moved to the farm' },
  resolvePrices: { channel: 'POS', branchId: randomUUID(), lines: [{ lineRef: '1', productId: randomUUID(), quantity: '1.000' }] },
  createPriceList: { code: 'BASE', name: 'Base prices', kind: 'BASE', taxInclusive: true },
  createPriceListVersion: { validFrom: '2026-12-01T00:00:00Z' },
  replacePriceListEntries: { version: 1, entries: [] },
  createTaxLevy: { code: 'TOURISM', name: 'Tourism Levy' },
  createTaxCategory: { code: 'SEEDS', name: 'Seeds and seedlings' },
  createTaxSchemeVersion: { validFrom: '2026-12-01', sourceNote: 'Rates from the accountant' },
  replaceTaxSchemeCells: { version: 1, cells: [] },
  calculateTax: { taxInclusive: false, taxDate: '2026-12-01', lines: [{ lineRef: '1', taxCategoryId: randomUUID(), amountPesewas: 100 }] },
  createPromotion: { code: 'XMAS-CHICKEN', name: 'Christmas chicken', kind: 'PERCENT_OFF', percentOff: '5', appliesTo: 'LINE', validFrom: '2026-12-01T00:00:00Z', validTo: '2027-01-01T00:00:00Z', targets: [{ productId: randomUUID() }] },
  updatePromotion: { version: 1, name: 'Christmas chicken' },
  endPromotion: { reason: 'Stock ran out' },
  createCoupon: { code: 'XMAS-26' },
  createCategory: { code: 'SEASONAL', name: 'Seasonal produce', productLine: 'PRODUCE', glGroup: 'PRODUCE_EGGS', taxCategoryId: randomUUID() },
  updateCategory: { version: 1, name: 'Seasonal' },
  archiveCategory: { version: 1, reason: 'No longer used' },
  createSpecies: { code: 'CATTLE', name: 'Cattle', trackingDefault: 'SERIAL' },
  updateSpecies: { version: 1, name: 'Cattle' },
  createGrade: { speciesId: randomUUID(), code: 'A', name: 'Grade A' },
  updateGrade: { version: 1, name: 'Grade A' },
  archiveGrade: { version: 1, reason: 'No longer used' },
  createWeightBand: { speciesId: randomUUID(), code: 'GOAT-S', minKg: '8.000', maxKg: '18.000' },
  updateWeightBand: { version: 1, maxKg: '19.000' },
  archiveWeightBand: { version: 1, reason: 'No longer used' },
  updateProduct: { version: 1, name: 'Goat' },
  createBranch: { code: 'KSI', name: 'Kumasi' },
  updateBranch: { version: 1, name: 'Kumasi' },
  createLocation: { branchId: '01900000-0000-7000-8000-00000000f001', code: 'PEN2', name: 'Pen', kind: 'PEN' },
  updateLocation: { version: 1, name: 'Pen' },
  createGoodsReceipt: { kind: 'HARVEST', locationId: randomUUID(), receivedAt: '2026-11-10T07:00:00Z', lines: [] },
  updateGoodsReceipt: { version: 1, notes: 'Two birds died on the road' },
  cancelGoodsReceipt: { reason: 'Delivery turned back at the gate' },
  reverseStockMovement: { reasonCode: 'COUNT_ERROR', note: 'Posted twice from the cold room tablet' },
  createStockTransfer: { fromLocationId: randomUUID(), toLocationId: randomUUID(), lines: [] },
  receiveStockTransfer: { lines: [] },
  cancelStockTransfer: { reason: 'Van not available' },
  createStockAdjustment: { locationId: randomUUID(), reasonCode: 'COUNT_ERROR', lines: [] },
  createStockTake: { locationId: randomUUID(), scope: 'FULL' },
  recordStockTakeCounts: { counts: [] },
  cancelStockTake: { reason: 'Refused' },
  createStockHold: { stockUnitId: '019a7a91-2f3b-74f5-9a2d-582bcbe2d109', kind: 'INVESTIGATION', note: 'Refused' },
  releaseStockHold: { reasonCode: 'INVESTIGATION_CLOSED', note: 'Refused' },
  resolveStockException: { resolutionKind: 'WRITE_OFF', note: 'Refused' },
  releaseStockReservation: { reason: 'Refused' },
  createReorderRule: { productId: '019a7a8e-e37e-7913-ae4c-9a0dc3bf12eb', branchId: '019a7a83-2aef-79e3-9f1b-a708a7ae1fe6', minQty: '10.000', reorderPointQty: '15.000', maxQty: '60.000' },
  updateReorderRule: { version: 1, reorderPointQty: '20.000' },
  recordTemperatureReading: { locationId: '019a7a84-4156-72e2-a81a-36fbeee7afd9', readingC: '-18.0', measuredAt: '2026-11-13T10:00:00Z', source: 'MANUAL' },
  archiveLocation: { version: 1, reason: 'Closed' },
  createCustomer: { kind: 'INDIVIDUAL', name: 'Ama' },
  updateCustomer: { version: 1, name: 'Ama' },
  archiveCustomer: { version: 1, reason: 'Duplicate' },
  createCustomerTier: { code: 'CATERING', name: 'Catering' },
  createCustomerAddress: { label: 'Home', recipientName: 'Ama', recipientPhone: '0244123456', line1: 'Market', area: 'Dodowa', city: 'Dodowa', region: 'Greater Accra' },
  updateCustomerAddress: { version: 1, label: 'Home' },
  archiveCustomerAddress: { version: 1, reason: 'Moved' },
  assignCustomerPriceList: { priceListId: '01900000-0000-7000-8000-00000000f002', validFrom: '2026-12-01T00:00:00Z' },
  archiveProduct: { version: 1, reason: 'No longer stocked' },
  addProductImage: { fileId: randomUUID(), altText: 'Front view' },
  createImportJob: { entity: 'CUSTOMER', fileId: randomUUID() },
  createExportJob: { entity: 'CUSTOMER', format: 'CSV' },
  updatePriceList: { version: 1, name: 'Base prices' },
  archivePriceList: { version: 1, reason: 'Replaced' },
  createSupplier: { name: 'Ashanti Feeds Ltd' },
  updateSupplier: { version: 1, name: 'Ashanti Feeds Ltd' },
  archiveSupplier: { version: 1, reason: 'Stopped trading' },
  updatePaymentMethod: { version: 1, isEnabled: false },
  createDeliveryZone: { branchId: randomUUID(), code: 'DODOWA', name: 'Dodowa', areas: ['Dodowa'], feePesewas: 1500, cutoffTime: '14:00' },
  updateDeliveryZone: { version: 1, feePesewas: 1500 },
  createRole: { code: 'SHOP_SUPERVISOR', name: 'Shop supervisor', requiresTotp: false, permissions: [] },
  updateRole: { version: 1, name: 'Shop supervisor' },
  rejectRequest: { reason: 'Not a mortality' },
  cancelApprovalRequest: { reason: 'Counted twice' },
};

beforeAll(async () => {
  database = await createTestDatabase();
  clock = new ManualClock(testStartTime());
  await relaxRateLimits(database);
  api = await startTestApp(database, { clock });
  dodowa = await createBranch(database);
  routes = registeredRoutes();
});

afterAll(async () => {
  await api.close();
  await database.drop();
});

describe('deny by default: the handler walk (ADR-0017, security architecture section 14)', () => {
  it('finds the B3, B4, B04 continued, B04d, B04d continued 1 to 3, B04e, B04e continued, B04e continued 2, B04e continued 3, B04e continued 4, B05 continued and B05 continued 3 routes, and every one declares its operation', () => {
    expect(routes.map((route) => route.spec?.operationId).sort()).toEqual(
      [
        'changePassword', 'confirmTotpEnrolment', 'createProduct', 'getCurrentSession', 'getHealth', 'getProduct', 'listProducts', 'listSessions',
        'loginCustomer', 'loginInvestor', 'loginStaff', 'logout', 'refreshSession', 'revokeSession', 'startTotpEnrolment', 'stepUp', 'verifyTotp',
        'resolvePrices', 'createPriceList', 'getPriceList', 'createPriceListVersion', 'getPriceListVersion', 'replacePriceListEntries', 'submitPriceListVersion',
        'listTaxLevies', 'createTaxLevy', 'listTaxCategories', 'createTaxCategory', 'listTaxSchemeVersions', 'createTaxSchemeVersion', 'getTaxSchemeVersion',
        'replaceTaxSchemeCells', 'submitTaxSchemeVersion', 'calculateTax',
        'listPromotions', 'createPromotion', 'getPromotion', 'updatePromotion', 'submitPromotion', 'endPromotion', 'listCoupons', 'createCoupon', 'validateCoupon',
        'listCategories', 'createCategory', 'getCategory', 'updateCategory', 'archiveCategory', 'listUnitsOfMeasure', 'listSpeciesList', 'createSpecies',
        'updateSpecies', 'listGrades', 'createGrade', 'updateGrade', 'archiveGrade', 'listWeightBands', 'createWeightBand', 'updateWeightBand',
        'archiveWeightBand', 'updateProduct',
        'listBranches', 'createBranch', 'getBranch', 'updateBranch', 'listLocations', 'createLocation', 'getLocation', 'updateLocation', 'archiveLocation',
        'listCustomers', 'createCustomer', 'getCustomer', 'updateCustomer', 'archiveCustomer', 'listCustomerTiers', 'createCustomerTier',
        'listCustomerAddresses', 'createCustomerAddress', 'updateCustomerAddress', 'archiveCustomerAddress', 'assignCustomerPriceList',
        'listSuppliers', 'createSupplier', 'getSupplier', 'updateSupplier', 'archiveSupplier', 'listPaymentMethods', 'updatePaymentMethod',
        'listDeliveryZones', 'createDeliveryZone', 'getDeliveryZone', 'updateDeliveryZone', 'quoteDelivery', 'listReasonCodes',
        'listPriceLists', 'updatePriceList', 'archivePriceList', 'listPriceListVersions', 'listPriceListEntries', 'archiveProduct',
        'listUsers', 'createUser', 'getUser', 'updateUser', 'disableUser', 'enableUser', 'unlockUser', 'resetUserPassword',
        'listRoles', 'getRole', 'listPermissions', 'listGrants', 'createGrant', 'revokeGrant',
        'createRole', 'updateRole', 'listApprovals', 'getApproval', 'approveRequest', 'rejectRequest', 'cancelApprovalRequest',
        'registerCustomer', 'verifyCustomerPhone', 'requestPasswordReset', 'resetPassword',
        'uploadFile', 'getFile', 'createFileSignedUrl',
        'addProductImage', 'removeProductImage',
        'listImportJobs', 'createImportJob', 'getImportJob', 'listImportErrors', 'applyImportJob', 'cancelImportJob', 'createExportJob',
        'listStockOnHand', 'getStockUnit', 'traceStockUnit',
        'listGoodsReceipts', 'createGoodsReceipt', 'getGoodsReceipt', 'updateGoodsReceipt', 'postGoodsReceipt', 'cancelGoodsReceipt',
        'listMovementTypes', 'listStockMovements', 'getStockMovement', 'reverseStockMovement', 'listStockUnitMovements',
        'listStockTransfers', 'createStockTransfer', 'getStockTransfer', 'dispatchStockTransfer', 'receiveStockTransfer', 'cancelStockTransfer',
        'listStockAdjustments', 'createStockAdjustment', 'getStockAdjustment', 'submitStockAdjustment',
        'listStockTakes', 'createStockTake', 'getStockTake', 'startStockTake', 'listStockTakeLines', 'recordStockTakeCounts', 'closeStockTakeCounting',
        'submitStockTake', 'cancelStockTake',
        'listStockHolds', 'createStockHold', 'releaseStockHold',
        'listStockExceptions', 'getStockException', 'resolveStockException',
        'listStockReservations', 'releaseStockReservation', 'listStockAvailability', 'listStockUnits',
        'listReorderRules', 'createReorderRule', 'updateReorderRule', 'listStockAlerts', 'listTemperatureReadings', 'recordTemperatureReading',
      ].sort(),
    );
    expect(routes.filter((route) => route.spec === undefined).map((route) => route.handler)).toEqual([]);
  });

  it('declares a permission on every staff operation that is not on the caller\'s own account or public', () => {
    const own = new Set(['logout', 'getCurrentSession', 'changePassword', 'startTotpEnrolment', 'confirmTotpEnrolment', 'stepUp']);
    for (const route of routes) {
      const spec = route.spec!;
      if (spec.access === 'PUBLIC' || own.has(spec.operationId) || spec.permissionByPolicy === true) {
        expect(spec.permission, spec.operationId).toBeNull();
        expect(spec.permissionByPolicy === true, spec.operationId).toBe(['approveRequest', 'rejectRequest'].includes(spec.operationId));
      } else {
        expect(spec.permission, spec.operationId).toMatch(/^[a-z]+\.[a-z_]+\.[a-z_.]+$/);
      }
    }
  });

  /** Reads whose query has a required parameter: without it the request is refused as invalid before it is authorised. */
  const VALID_QUERY: Record<string, string> = { listStockAvailability: `?branchId=${randomUUID()}` };

  it('refuses a staff user who holds no grant on every permissioned operation, with 403 FORBIDDEN', async () => {
    const nobody = await createUser(database, { name: 'Kwame Nkansah' });
    const session = await login(api.server, nobody);
    const guarded = routes.filter((route) => (route.spec?.permission !== null && route.spec?.permission !== undefined) || route.spec?.permissionByPolicy === true);
    expect(guarded.length).toBeGreaterThanOrEqual(5);
    for (const route of guarded) {
      const path = route.path.replace(/:[a-zA-Z]+/g, randomUUID());
      const body = VALID_BODY[route.spec!.operationId] ?? {};
      const response =
        route.method === 'GET'
          ? await consoleGet(api.server, session, `${path}${VALID_QUERY[route.spec!.operationId] ?? ''}`)
          : route.method === 'PUT' || route.method === 'PATCH' || route.method === 'DELETE'
            ? await (route.method === 'PUT' ? request(api.server).put(path) : route.method === 'PATCH' ? request(api.server).patch(path) : request(api.server).delete(path))
                .set('Cookie', session.jar.header())
                .set('X-CSRF-Token', session.csrfToken)
                .set('Origin', TEST_ORIGIN)
                .set('Idempotency-Key', randomUUID())
                .send(body)
            : route.spec!.operationId === 'uploadFile'
              ? await consolePost(api.server, session, path).field('purpose', 'EVIDENCE').attach('file', Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]), 'pen.jpg')
              : await consolePost(api.server, session, path).send(body);
      expect(response.status, `${route.method} ${route.path}`).toBe(403);
      expect(response.body.error.code, route.path).toBe('FORBIDDEN');
    }
  });

  it('audits each refusal on its own connection, so it survives the refused command\'s rollback', async () => {
    const { rows } = await database
      .pool('admin')
      .query<{ permission: string; reason: string }>(
        "SELECT metadata->>'permission' AS permission, metadata->>'reason' AS reason FROM platform.audit_event WHERE action = 'AUTHORISATION_FAILURE'",
      );
    expect(rows.map((row) => row.permission)).toEqual(expect.arrayContaining(['mdm.product.read', 'mdm.product.create', 'iam.session.read', 'iam.session.revoke']));
    expect(new Set(rows.map((row) => row.reason))).toEqual(new Set(['NO_GRANT']));
  });
});

describe('the seeded roles (ADR-0017: a test per role that a forbidden action is refused)', () => {
  const withoutCreate: RoleCode[] = ['ACCOUNTANT', 'STOREKEEPER', 'CASHIER', 'SALES', 'FARM_HAND', 'DRIVER'];

  for (const role of withoutCreate) {
    it(`refuses a ${role} who tries to create a product`, async () => {
      const user = await createUser(database, { name: `Test ${role}`, grants: [{ role, branchId: dodowa.branchId }] });
      const session = role === 'ACCOUNTANT' ? await enrolAndLogin(api.server, user, () => clock.now()) : await login(api.server, user);
      expect((await consoleGet(api.server, session, '/v1/products')).status).toBe(200);
      const created = await consolePost(api.server, session, '/v1/products').send(VALID_BODY['createProduct']);
      expect(created.status).toBe(403);
      expect(created.body.error.code).toBe('FORBIDDEN');
    });
  }

  it('refuses investors and customers at every staff operation, because their sessions are of another realm', async () => {
    for (const realm of ['INVESTOR', 'CUSTOMER'] as const) {
      const user = await createUser(database, { name: `Test ${realm}`, realm });
      const session = await login(api.server, user);
      expect((await consoleGet(api.server, session, '/v1/products')).status).toBe(401);
      expect((await consoleGet(api.server, session, '/v1/iam/sessions')).status).toBe(401);
    }
  });
});

describe('the device list and forced logout (ADR-0016, FR-IAM-016)', () => {
  it('lets a cashier list their own sessions and refuses them anyone else\'s', async () => {
    const cashier = await createUser(database, { name: 'Adwoa Darko', grants: [{ role: 'CASHIER', branchId: dodowa.branchId, locationId: dodowa.shopId }] });
    const other = await createUser(database, { name: 'Kofi Boadu', grants: [{ role: 'CASHIER', branchId: dodowa.branchId }] });
    const session = await login(api.server, cashier, 'Shop till tablet');
    await login(api.server, cashier, 'Adwoa phone');
    const own = await consoleGet(api.server, session, '/v1/iam/sessions');
    expect(own.status).toBe(200);
    expect(own.body.data.map((row: { deviceLabel: string }) => row.deviceLabel).sort()).toEqual(['Adwoa phone', 'Shop till tablet']);
    expect(own.body.data.filter((row: { current: boolean }) => row.current)).toHaveLength(1);
    expect(own.body.page).toEqual({ nextCursor: null, limit: 25, hasMore: false });
    const theirs = await consoleGet(api.server, session, `/v1/iam/sessions?principalId=${other.principalId}`);
    expect(theirs.status).toBe(403);
  });

  it('pages the device list with a signed cursor that refuses tampering', async () => {
    const cashier = await createUser(database, { name: 'Ama Owusu', grants: [{ role: 'CASHIER', branchId: dodowa.branchId }] });
    const session = await login(api.server, cashier);
    await login(api.server, cashier);
    await login(api.server, cashier);
    const first = await consoleGet(api.server, session, '/v1/iam/sessions?limit=2');
    expect(first.body.data).toHaveLength(2);
    expect(first.body.page.hasMore).toBe(true);
    const second = await consoleGet(api.server, session, `/v1/iam/sessions?limit=2&cursor=${encodeURIComponent(first.body.page.nextCursor)}`);
    expect(second.body.data).toHaveLength(1);
    expect(second.body.page).toEqual({ nextCursor: null, limit: 2, hasMore: false });
    const tampered = `${first.body.page.nextCursor.slice(0, -2)}xx`;
    const refused = await consoleGet(api.server, session, `/v1/iam/sessions?limit=2&cursor=${encodeURIComponent(tampered)}`);
    expect(refused.status).toBe(400);
    expect(refused.body.error.details[0].field).toBe('/cursor');
  });

  it('lets a manager revoke a cashier\'s session, which then fails on its next request, and replays the revoke once', async () => {
    const manager = await createUser(database, { name: 'Kwabena Owusu', grants: [{ role: 'MANAGER', branchId: dodowa.branchId }] });
    const cashier = await createUser(database, { name: 'Efua Mensah', grants: [{ role: 'CASHIER', branchId: dodowa.branchId }] });
    const managerSession = await enrolAndLogin(api.server, manager, () => clock.now());
    const cashierSession = await login(api.server, cashier);
    expect((await consoleGet(api.server, cashierSession, '/v1/products')).status).toBe(200);

    const key = randomUUID();
    const revoke = () => consolePost(api.server, managerSession, `/v1/iam/sessions/${cashierSession.sessionId}/revoke`, key).send({ reason: 'Tablet left unattended overnight' });
    expect((await revoke()).status).toBe(204);
    expect((await consoleGet(api.server, cashierSession, '/v1/products')).status).toBe(401);
    expect((await revoke()).status).toBe(204);
    const changed = await consolePost(api.server, managerSession, `/v1/iam/sessions/${cashierSession.sessionId}/revoke`, key).send({ reason: 'A different reason' });
    expect(changed.status).toBe(409);
    expect(changed.body.error.code).toBe('IDEMPOTENCY_KEY_REUSED');

    const { rows } = await database.pool('admin').query<{ revoke_reason: string; revoked_by: string }>('SELECT revoke_reason, revoked_by FROM iam.session WHERE id = $1', [
      cashierSession.sessionId,
    ]);
    expect(rows[0]).toEqual({ revoke_reason: 'Tablet left unattended overnight', revoked_by: manager.principalId });
  });

  it('refuses a state change with no Idempotency-Key, before doing anything', async () => {
    const cashier = await createUser(database, { name: 'Kojo Asare', grants: [{ role: 'CASHIER', branchId: dodowa.branchId }] });
    const session = await login(api.server, cashier);
    const response = await request(api.server)
      .post(`/v1/iam/sessions/${session.sessionId}/revoke`)
      .set('Cookie', session.jar.header())
      .set('Origin', TEST_ORIGIN)
      .set('X-CSRF-Token', session.csrfToken)
      .send({ reason: 'Lost phone' });
    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('IDEMPOTENCY_KEY_REQUIRED');
    expect((await consoleGet(api.server, session, '/v1/auth/session')).status).toBe(200);
  });
});
