import type { INestApplicationContext } from '@nestjs/common';
import type pg from 'pg';
import { UomConversions } from '../modules/mdm';
import { PG_POOL } from '../platform/platform.module';
import { SeedStaff } from './seed-staff';
import type { ServiceSeedUnit } from './seed-unit';

/**
 * The seeded farm's alternative units (FR-MDM-003, B06u, A-163), SEED: the broiler grower pellets come in 50 kg bags
 * and the goat and sheep concentrate in 25 kg bags, both held by the kilogram; cabbages are counted by the head and
 * sold to traders by the crate of 24. Each is an exact numerator and denominator to the product's base unit. Meat has
 * none: a catch-weight pack is charged by its weighed kilograms (A-157).
 */
export const SEED_UOM_CONVERSIONS = [
  { sku: 'FEED-0001', fromUom: 'BAG', numerator: 50, denominator: 1 },
  { sku: 'FEED-0002', fromUom: 'BAG', numerator: 25, denominator: 1 },
  { sku: 'PRD-0002', fromUom: 'CRATE', numerator: 24, denominator: 1 },
] as const;

const key = (...parts: string[]): string => `seed:mdm-units:${parts.join(':')}`;

/**
 * Writes the conversions through MDM's `UomConversions` as the seeded Manager, after the LIV seed has made the feed
 * products, skipping any product that already converts from the unit.
 */
export function farmSeedMdmUnits(): ServiceSeedUnit {
  return {
    kind: 'SERVICE',
    name: 'mdm-unit-conversions',
    async run(app: INestApplicationContext) {
      const staff = await SeedStaff.load(app);
      const pool = app.get<pg.Pool>(PG_POOL);
      const products = new Map((await pool.query<{ sku: string; id: string }>('SELECT sku, id FROM mdm.product WHERE deleted_at IS NULL')).rows.map((r) => [r.sku, r.id]));
      const conversions = app.get(UomConversions);
      return staff.as('manager', async (manager) => {
        const existing = new Set((await conversions.list(manager, { includeArchived: false }, undefined, 100)).data.map((c) => `${c.product.sku}:${c.fromUom}`));
        let written = 0;
        for (const conversion of SEED_UOM_CONVERSIONS) {
          if (existing.has(`${conversion.sku}:${conversion.fromUom}`)) continue;
          const productId = products.get(conversion.sku);
          if (productId === undefined) throw new Error(`the unit conversion seed needs product ${conversion.sku}, which an earlier seed unit creates; run the seed units in order`);
          await conversions.create(manager, { productId, fromUom: conversion.fromUom, numerator: conversion.numerator, denominator: conversion.denominator }, key(conversion.sku, conversion.fromUom));
          written += 1;
        }
        return { records: written };
      });
    },
  };
}
