import type { Transaction } from '../../../platform/database/unit-of-work';
import type { SubledgerSource } from '../../fin';
import type { MasterDataRefs } from '../../mdm';
import type { StockStore } from './stock-store';

/**
 * INV's subledger for the inventory control accounts (ADR-0056, FR-FIN-016): the value of the cost pools, per GL group
 * of their products. FIN maps each group to its inventory account and compares the two each night; INV never sees an
 * account code.
 */
export class StockValueSource implements SubledgerSource {
  readonly name = 'inv.stock-value';
  readonly determinantType = 'GL_GROUP' as const;
  readonly role = 'INVENTORY';

  constructor(
    private readonly store: StockStore,
    private readonly refs: MasterDataRefs,
  ) {}

  async valuesIn(tx: Transaction): Promise<{ readonly key: string; readonly pesewas: bigint }[]> {
    const pools = await this.store.poolValueByProduct(tx);
    const products = await this.refs.productsIn(
      tx,
      pools.map((p) => p.productId),
    );
    const byGroup = new Map<string, bigint>();
    for (const pool of pools) {
      const group = products.get(pool.productId)!.glGroup;
      byGroup.set(group, (byGroup.get(group) ?? 0n) + pool.valuePesewas);
    }
    return [...byGroup].map(([key, pesewas]) => ({ key, pesewas }));
  }
}
