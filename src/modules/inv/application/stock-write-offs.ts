import type { Transaction } from '../../../platform/database/unit-of-work';
import type { DocumentRegistry } from '../../../platform/documents/document-registry';
import type { ApprovalHandler, ApprovalRecord } from '../../iam';

/**
 * IAM keeps one handler per approval kind (ADR-0017), and two INV documents ask for a `STOCK_WRITE_OFF`: an adjustment
 * (FR-INV-012) and a stock take's variances (FR-INV-013). This handler hands each request to the document's own
 * handler by the subject's registered type, so both share the one policy, threshold and approver permission.
 */
export class StockWriteOffs implements ApprovalHandler {
  constructor(
    private readonly documents: DocumentRegistry,
    private readonly byDocType: Readonly<Record<string, ApprovalHandler>>,
  ) {}

  async currentPayloadHash(tx: Transaction, subjectDocumentId: string): Promise<string> {
    return (await this.handlerFor(tx, subjectDocumentId)).currentPayloadHash(tx, subjectDocumentId);
  }

  async onApproved(tx: Transaction, request: ApprovalRecord): Promise<void> {
    await (await this.handlerFor(tx, request.subjectDocumentId)).onApproved(tx, request);
  }

  async onRejected(tx: Transaction, request: ApprovalRecord): Promise<void> {
    await (await this.handlerFor(tx, request.subjectDocumentId)).onRejected?.(tx, request);
  }

  private async handlerFor(tx: Transaction, subjectDocumentId: string): Promise<ApprovalHandler> {
    const docType = (await this.documents.refs(tx, [subjectDocumentId])).get(subjectDocumentId)?.docType;
    const handler = docType === undefined ? undefined : this.byDocType[docType];
    if (handler === undefined) throw new Error(`a stock write-off approval names ${subjectDocumentId}, a ${docType ?? 'unregistered'} document no INV handler takes`);
    return handler;
  }
}
