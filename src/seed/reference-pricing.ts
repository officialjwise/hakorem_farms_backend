import { halfUpDivide } from '@hakorem/kernel';

/**
 * The reference catalogue's prices as seed data (shared brief, "Reference catalogue"; hakorem-seed). One plain
 * definition: the B4 seed unit writes it, and the B4 gate test walks it as its oracle. Every band, list, tier and
 * customer here is SEED, configured data the owner replaces; nothing in the engine knows these numbers.
 *
 * Live animals are priced per head in weight bands whose floors and ceilings together span the brief's indicative
 * range (a goat from GHS 120 to GHS 1,950). Meat is priced per kilogram so a 15 kg pack spans the brief's pack band
 * (full chicken GHS 220 to 350 is 1,467 to 2,333 pesewas a kilogram). Eggs are a fixed price per crate. Produce is
 * priced for the season, except lettuce, which has no price yet this season and so must be quoted.
 */

export type Basis = 'PER_HEAD' | 'PER_KG' | 'PER_UNIT';
export type SeedChannel = 'POS' | 'ONLINE' | 'WHOLESALE' | 'QUOTE';
export type SeedTier = 'RETAIL' | 'WHOLESALE' | 'RESELLER';

export interface SeedBand {
  readonly code: string;
  readonly minKg: string;
  readonly maxKg: string;
}

export interface SeedSpecies {
  readonly code: string;
  readonly bands: readonly SeedBand[];
  readonly grades: ReadonlyArray<{ readonly code: string; readonly name: string; readonly description: string }>;
}

export interface SeedProduct {
  readonly sku: string;
  readonly name: string;
  readonly category: 'LIVE' | 'MEAT' | 'EGGS' | 'PRODUCE';
  readonly species: string | null;
  readonly policy: 'SERIALISED' | 'CATCH_WEIGHT' | 'COUNTABLE';
  readonly baseUom: string;
  readonly saleUom: string;
  readonly onlineMode: 'HIDDEN' | 'LISTED' | 'REQUEST_TO_BUY';
  /** Seeded by B3 already; the B4 unit finds it by SKU. */
  readonly fromB3: boolean;
}

export interface SeedEntry {
  readonly sku: string;
  readonly band: string | null;
  readonly grade: string | null;
  readonly basis: Basis;
  readonly floor: bigint;
  readonly list: bigint;
  readonly ceiling: bigint;
  readonly quoteOnly: boolean;
}

export interface SeedPriceList {
  readonly code: string;
  readonly name: string;
  readonly kind: 'BASE' | 'CHANNEL' | 'TIER' | 'CUSTOMER';
  readonly channel: SeedChannel | null;
  readonly tier: SeedTier | null;
  readonly entries: readonly SeedEntry[];
}

export interface SeedCustomer {
  readonly customerNo: string;
  readonly name: string;
  readonly kind: 'INDIVIDUAL' | 'BUSINESS';
  readonly tier: SeedTier;
  /** The CUSTOMER list assigned to them, by code. */
  readonly assignedList: string | null;
}

export const SEED_SPECIES: readonly SeedSpecies[] = [
  { code: 'BROILER', grades: [], bands: [{ code: 'BR-S', minKg: '1.500', maxKg: '2.200' }, { code: 'BR-M', minKg: '2.200', maxKg: '3.000' }, { code: 'BR-L', minKg: '3.000', maxKg: '4.500' }] },
  { code: 'LOCAL_CHICKEN', grades: [], bands: [{ code: 'LC-S', minKg: '0.800', maxKg: '1.400' }, { code: 'LC-M', minKg: '1.400', maxKg: '2.000' }, { code: 'LC-L', minKg: '2.000', maxKg: '3.000' }] },
  { code: 'PIG', grades: [], bands: [{ code: 'PIG-W', minKg: '5.000', maxKg: '15.000' }, { code: 'PIG-G', minKg: '15.000', maxKg: '40.000' }, { code: 'PIG-F', minKg: '40.000', maxKg: '90.000' }] },
  {
    code: 'GOAT',
    grades: [
      { code: 'A', name: 'Grade A, well finished', description: 'Good body condition, no defects. SEED' },
      { code: 'B', name: 'Grade B, standard', description: 'Fair body condition. SEED' },
    ],
    bands: [
      { code: 'GOAT-S', minKg: '8.000', maxKg: '18.000' },
      { code: 'GOAT-M', minKg: '18.000', maxKg: '28.000' },
      { code: 'GOAT-L', minKg: '28.000', maxKg: '40.000' },
      { code: 'GOAT-XL', minKg: '40.000', maxKg: '60.000' },
    ],
  },
  {
    code: 'SHEEP',
    grades: [],
    bands: [
      { code: 'SHEEP-S', minKg: '15.000', maxKg: '30.000' },
      { code: 'SHEEP-M', minKg: '30.000', maxKg: '45.000' },
      { code: 'SHEEP-L', minKg: '45.000', maxKg: '65.000' },
      { code: 'SHEEP-XL', minKg: '65.000', maxKg: '100.000' },
    ],
  },
  { code: 'DUCK', grades: [], bands: [{ code: 'DUCK-S', minKg: '1.500', maxKg: '2.500' }, { code: 'DUCK-L', minKg: '2.500', maxKg: '5.000' }] },
  { code: 'RABBIT', grades: [], bands: [{ code: 'RAB-S', minKg: '1.000', maxKg: '2.000' }, { code: 'RAB-L', minKg: '2.000', maxKg: '4.000' }] },
];

/** Goats, sheep, pigs and rabbits are tagged individuals; broilers, local chickens and ducks are counted in flocks. */
const live = (sku: string, name: string, species: string, policy: 'SERIALISED' | 'COUNTABLE', fromB3 = false): SeedProduct => ({
  sku,
  name,
  category: 'LIVE',
  species,
  policy,
  baseUom: 'HEAD',
  saleUom: 'HEAD',
  onlineMode: 'REQUEST_TO_BUY',
  fromB3,
});
const meat = (sku: string, name: string, fromB3 = false): SeedProduct => ({ sku, name, category: 'MEAT', species: null, policy: 'CATCH_WEIGHT', baseUom: 'KG', saleUom: 'PACK', onlineMode: 'LISTED', fromB3 });
const countable = (sku: string, name: string, category: 'EGGS' | 'PRODUCE', uom: string, fromB3 = false): SeedProduct => ({
  sku,
  name,
  category,
  species: null,
  policy: 'COUNTABLE',
  baseUom: uom,
  saleUom: uom,
  onlineMode: 'LISTED',
  fromB3,
});

/** The whole reference catalogue: six products B3 seeded, and the rest. */
export const SEED_PRODUCTS: readonly SeedProduct[] = [
  live('LIV-BROILER', 'Broiler chicken', 'BROILER', 'COUNTABLE'),
  live('LIV-LOCAL-CHICKEN', 'Local chicken', 'LOCAL_CHICKEN', 'COUNTABLE'),
  live('LIV-PIG', 'Baby pig', 'PIG', 'SERIALISED'),
  live('LIV-GOAT', 'Goat', 'GOAT', 'SERIALISED', true),
  live('LIV-SHEEP', 'Sheep', 'SHEEP', 'SERIALISED', true),
  live('LIV-DUCK', 'Duck', 'DUCK', 'COUNTABLE'),
  live('LIV-RABBIT', 'Rabbit', 'RABBIT', 'SERIALISED'),
  meat('MEAT-CHICKEN-FULL-15KG', 'Full chicken, 15 kg pack'),
  meat('MEAT-CHICKEN-WINGS-15KG', 'Chicken wings, 15 kg pack', true),
  meat('MEAT-CHICKEN-DT-15KG', 'Chicken drumsticks and thighs, 15 kg pack'),
  meat('MEAT-CHICKEN-BACKS-15KG', 'Chicken backs, 15 kg pack'),
  meat('MEAT-BEEF-15KG', 'Beef, 15 kg pack'),
  meat('MEAT-PORK-15KG', 'Pork, 15 kg pack'),
  meat('MEAT-GOAT-15KG', 'Goat meat, 15 kg pack', true),
  countable('EGG-CRATE-LOCAL', 'Eggs, local, crate of 30', 'EGGS', 'CRATE'),
  countable('EGG-CRATE-SMALL', 'Eggs, small, crate of 30', 'EGGS', 'CRATE'),
  countable('EGG-CRATE-BIG', 'Eggs, big, crate of 30', 'EGGS', 'CRATE', true),
  countable('PRD-TOMATO-CRATE', 'Tomatoes, crate', 'PRODUCE', 'CRATE'),
  countable('PRD-CABBAGE-HEAD', 'Cabbage, per head', 'PRODUCE', 'UNIT'),
  countable('PRD-PEPPER-BAG', 'Pepper, bag', 'PRODUCE', 'BAG'),
  countable('PRD-CARROT-CRATE', 'Carrots, crate', 'PRODUCE', 'CRATE'),
  countable('PRD-YAM-TUBER', 'Yam, per tuber', 'PRODUCE', 'TUBER', true),
  countable('PRD-LETTUCE-HEAD', 'Lettuce, per head', 'PRODUCE', 'UNIT'),
];

const entry = (sku: string, basis: Basis, floor: number, list: number, ceiling: number, band: string | null = null, grade: string | null = null): SeedEntry => ({
  sku,
  band,
  grade,
  basis,
  floor: BigInt(floor),
  list: BigInt(list),
  ceiling: BigInt(ceiling),
  quoteOnly: false,
});
const head = (sku: string, band: string, floor: number, list: number, ceiling: number, grade: string | null = null) => entry(sku, 'PER_HEAD', floor, list, ceiling, band, grade);
const quoteOnly = (sku: string, basis: Basis, band: string | null): SeedEntry => ({ sku, band, grade: null, basis, floor: 0n, list: 0n, ceiling: 0n, quoteOnly: true });

/** Counter and every channel without its own list: the base prices, tax-inclusive (A-023). */
const BASE_ENTRIES: readonly SeedEntry[] = [
  head('LIV-BROILER', 'BR-S', 12_000, 13_500, 15_000),
  head('LIV-BROILER', 'BR-M', 15_000, 17_000, 18_500),
  head('LIV-BROILER', 'BR-L', 18_500, 20_000, 22_000),
  head('LIV-LOCAL-CHICKEN', 'LC-S', 10_000, 11_500, 13_000),
  head('LIV-LOCAL-CHICKEN', 'LC-M', 13_000, 14_500, 15_500),
  head('LIV-LOCAL-CHICKEN', 'LC-L', 15_500, 16_500, 18_000),
  head('LIV-PIG', 'PIG-W', 15_000, 22_000, 30_000),
  head('LIV-PIG', 'PIG-G', 30_000, 60_000, 90_000),
  head('LIV-PIG', 'PIG-F', 90_000, 150_000, 220_000),
  head('LIV-GOAT', 'GOAT-S', 12_000, 25_000, 40_000),
  head('LIV-GOAT', 'GOAT-M', 40_000, 65_000, 90_000),
  head('LIV-GOAT', 'GOAT-M', 45_000, 72_000, 90_000, 'A'),
  head('LIV-GOAT', 'GOAT-L', 90_000, 120_000, 150_000),
  head('LIV-GOAT', 'GOAT-L', 100_000, 130_000, 150_000, 'A'),
  head('LIV-GOAT', 'GOAT-XL', 150_000, 170_000, 195_000),
  head('LIV-SHEEP', 'SHEEP-S', 15_000, 40_000, 70_000),
  head('LIV-SHEEP', 'SHEEP-M', 70_000, 110_000, 150_000),
  head('LIV-SHEEP', 'SHEEP-L', 150_000, 220_000, 300_000),
  // A festival ram is priced by negotiation, never from a list.
  quoteOnly('LIV-SHEEP', 'PER_HEAD', 'SHEEP-XL'),
  head('LIV-DUCK', 'DUCK-S', 8_000, 12_000, 16_000),
  head('LIV-DUCK', 'DUCK-L', 16_000, 24_000, 30_000),
  head('LIV-RABBIT', 'RAB-S', 8_000, 12_000, 18_000),
  head('LIV-RABBIT', 'RAB-L', 18_000, 26_000, 35_000),
  entry('MEAT-CHICKEN-FULL-15KG', 'PER_KG', 1_467, 1_900, 2_333),
  entry('MEAT-CHICKEN-WINGS-15KG', 'PER_KG', 733, 1_100, 1_667),
  entry('MEAT-CHICKEN-DT-15KG', 'PER_KG', 1_200, 1_800, 2_467),
  entry('MEAT-CHICKEN-BACKS-15KG', 'PER_KG', 1_067, 1_300, 1_600),
  entry('MEAT-BEEF-15KG', 'PER_KG', 2_200, 3_060, 4_333),
  entry('MEAT-PORK-15KG', 'PER_KG', 1_133, 1_700, 2_267),
  entry('MEAT-GOAT-15KG', 'PER_KG', 1_400, 2_200, 3_133),
  entry('EGG-CRATE-LOCAL', 'PER_UNIT', 3_500, 3_500, 3_500),
  entry('EGG-CRATE-SMALL', 'PER_UNIT', 4_500, 4_500, 4_500),
  entry('EGG-CRATE-BIG', 'PER_UNIT', 6_000, 6_000, 6_000),
  entry('PRD-TOMATO-CRATE', 'PER_UNIT', 35_000, 40_000, 45_000),
  entry('PRD-CABBAGE-HEAD', 'PER_UNIT', 800, 1_000, 1_200),
  entry('PRD-PEPPER-BAG', 'PER_UNIT', 25_000, 30_000, 35_000),
  entry('PRD-CARROT-CRATE', 'PER_UNIT', 20_000, 25_000, 30_000),
  entry('PRD-YAM-TUBER', 'PER_UNIT', 1_500, 2_000, 2_500),
];

/** A price a percentage below another, rounded half-up once: `percentOff` of 10 is ten percent off. */
function less(pesewas: bigint, percentOff: bigint): bigint {
  return halfUpDivide(pesewas * (100n - percentOff), 100n);
}

/**
 * A derived list: the base entries of the chosen products, list and floor `percentOff` lower, the ceiling kept at the
 * base list price, so a negotiated price can still reach the counter price without approval.
 */
function discounted(predicate: (entry: SeedEntry) => boolean, percentOff: bigint): SeedEntry[] {
  return BASE_ENTRIES.filter((e) => !e.quoteOnly && predicate(e)).map((e) => ({ ...e, floor: less(e.floor, percentOff), list: less(e.list, percentOff), ceiling: e.list }));
}

const isMeat = (e: SeedEntry) => e.sku.startsWith('MEAT-');
const isLiveRuminantOrPig = (e: SeedEntry) => ['LIV-GOAT', 'LIV-SHEEP', 'LIV-PIG'].includes(e.sku);
const isEggs = (e: SeedEntry) => e.sku.startsWith('EGG-');

export const SEED_PRICE_LISTS: readonly SeedPriceList[] = [
  { code: 'BASE', name: 'Base prices (SEED)', kind: 'BASE', channel: null, tier: null, entries: BASE_ENTRIES },
  // Online: meat carries cold-chain handling, 5 percent above the counter; floors and ceilings move with it.
  {
    code: 'ONLINE',
    name: 'Online store prices (SEED)',
    kind: 'CHANNEL',
    channel: 'ONLINE',
    tier: null,
    entries: BASE_ENTRIES.filter(isMeat).map((e) => ({ ...e, floor: less(e.floor, -5n), list: less(e.list, -5n), ceiling: less(e.ceiling, -5n) })),
  },
  { code: 'WHOLESALE', name: 'Wholesale prices (SEED)', kind: 'CHANNEL', channel: 'WHOLESALE', tier: null, entries: discounted((e) => isMeat(e) || isLiveRuminantOrPig(e), 10n) },
  { code: 'WHL-WHOLESALE-TIER', name: 'Wholesale tier on the wholesale channel (SEED)', kind: 'TIER', channel: 'WHOLESALE', tier: 'WHOLESALE', entries: discounted(isMeat, 12n) },
  { code: 'WHL-RESELLER-TIER', name: 'Resellers on the wholesale channel (SEED)', kind: 'TIER', channel: 'WHOLESALE', tier: 'RESELLER', entries: discounted((e) => isMeat(e) || isEggs(e), 15n) },
  { code: 'POS-RESELLER-TIER', name: 'Resellers at the counter (SEED)', kind: 'TIER', channel: 'POS', tier: 'RESELLER', entries: discounted(isEggs, 8n) },
  {
    code: 'CATERERS-2026',
    name: 'Accra Event Caterers contract 2026 (SEED)',
    kind: 'CUSTOMER',
    channel: null,
    tier: null,
    entries: [head('LIV-GOAT', 'GOAT-M', 68_000, 70_000, 72_000, 'A'), entry('MEAT-CHICKEN-FULL-15KG', 'PER_KG', 1_650, 1_700, 1_750)],
  },
];

export const SEED_CUSTOMERS: readonly SeedCustomer[] = [
  { customerNo: 'C-00001', name: 'Ama Serwaa (SEED)', kind: 'INDIVIDUAL', tier: 'RETAIL', assignedList: null },
  { customerNo: 'C-00002', name: 'Tema Cold Store Ltd (SEED)', kind: 'BUSINESS', tier: 'WHOLESALE', assignedList: null },
  { customerNo: 'C-00003', name: 'Madina Market Traders (SEED)', kind: 'BUSINESS', tier: 'RESELLER', assignedList: null },
  { customerNo: 'C-00004', name: 'Accra Event Caterers (SEED)', kind: 'BUSINESS', tier: 'WHOLESALE', assignedList: 'CATERERS-2026' },
];
