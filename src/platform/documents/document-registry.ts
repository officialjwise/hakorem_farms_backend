import type { Transaction } from '../database/unit-of-work';

export interface DocumentRegistration {
  readonly id: string;
  /** A code seeded in `platform.document_type` by the owning module's migration. */
  readonly docType: string;
  readonly ownerModule: string;
  readonly branchId: string;
  readonly actorId: string;
}

/**
 * The document registry (ADR-0011): every business document's id is first a row of `platform.business_document`,
 * so approvals, audit and `source_document_id` can point at any document without a key into another module's
 * schema. A module registers its document here, in its own transaction, then inserts the document with that id.
 */
export class DocumentRegistry {
  async register(tx: Transaction, document: DocumentRegistration): Promise<void> {
    await tx.query('INSERT INTO platform.business_document (id, doc_type, owner_module, branch_id, actor_id) VALUES ($1, $2, $3, $4, $5)', [
      document.id,
      document.docType,
      document.ownerModule,
      document.branchId,
      document.actorId,
    ]);
  }
}
