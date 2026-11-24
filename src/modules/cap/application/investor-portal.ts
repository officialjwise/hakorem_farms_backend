import { Money, type Clock } from '@hakorem/kernel';
import type { AuditTrail } from '../../../platform/audit/audit-trail';
import type { Actor } from '../../../platform/context/request-context';
import type { Transaction, UnitOfWork } from '../../../platform/database/unit-of-work';
import { ForbiddenError, NotFoundError, UnauthenticatedError } from '../../../platform/errors/api-error';
import type { Cursors } from '../../../platform/http/cursor';
import type { FileStore } from '../../../platform/storage/file-store';
import { formatUnits, sharePercent } from '../domain/distribution';
import type { CapBooksStore } from './cap-books-store';
import { pageAfter } from './counting';
import type { CapStore, InvestorRecord } from './cap-store';
import { investorRef, type Capital, type CapitalTransactionView, type InvestorRefView, type Page } from './capital';
import type { InvestorDocumentView, InvestorProfiles } from './investor-profiles';
import type { InvestorReturns, InvestorReturnsView, InvestorStatementView } from './investor-returns';

const json = (n: bigint): number => Money.ofPesewas(n).toJsonInteger();
/** How long a signed link to an investor's own document lives (FR-DOC: signed, expiring, each issue logged). */
const DOCUMENT_LINK_SECONDS = 300;

/** The contract's `InvestorPortalSummary`. */
export interface InvestorPortalSummaryView {
  readonly investor: InvestorRefView;
  readonly units: string;
  readonly sharePercent: string;
  readonly contributedPesewas: number;
  readonly allocatedPesewas: number;
  readonly paidPesewas: number;
  readonly outstandingPesewas: number;
  readonly returns: InvestorReturnsView;
  readonly asOf: string;
  readonly currency: 'GHS';
}

/** The contract's `InvestorDistributionLine`. */
export interface InvestorDistributionLineView {
  readonly runId: string;
  readonly runNo: string;
  readonly periodStart: string;
  readonly periodEnd: string;
  readonly unitDays: string;
  readonly allocatedPesewas: number;
  readonly withheldPesewas: number;
  readonly netPayablePesewas: number;
  readonly paidPesewas: number;
  readonly status: 'PAID' | 'PARTLY_PAID' | 'UNPAID';
  readonly currency: 'GHS';
}

/**
 * The investor portal's read model (FR-IAM-013, FR-CAP-013, UAT scenario 4 steps 4.10 and 4.11): six reads for a
 * signed-in INVESTOR, each about the investor whose portal login it is and nobody else. No request names an investor:
 * the record is found by the session's principal, so another investor's figures cannot be asked for (a document of
 * someone else's answers 404). A staff session, a customer, or an investor login no investor record holds is refused
 * (403, audited). The portal's own subdomain and cookie are B13's (the owner): nothing here widens a cookie.
 */
export class InvestorPortal {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly store: CapStore,
    private readonly books: CapBooksStore,
    private readonly capital: Capital,
    private readonly returns: InvestorReturns,
    private readonly profiles: InvestorProfiles,
    private readonly files: FileStore,
    private readonly audit: AuditTrail,
    private readonly cursors: Cursors,
    private readonly clock: Clock,
  ) {}

  summary(actor: Actor | undefined): Promise<InvestorPortalSummaryView> {
    return this.read(actor, async (tx, investor) => {
      const holdings = await this.store.holdingsIn(tx, [investor.id]);
      const holding = holdings.get(investor.id);
      const units = holding?.unitsE4 ?? 0n;
      const distributed = await this.returns.distributedIn(tx, investor.id);
      return {
        investor: investorRef(investor),
        units: formatUnits(units),
        sharePercent: sharePercent(units, await this.store.unitsInIssue(tx)),
        contributedPesewas: json(holding?.contributedPesewas ?? 0n),
        allocatedPesewas: json(distributed.allocated),
        paidPesewas: json(distributed.paid),
        outstandingPesewas: json(distributed.netPayable - distributed.paid),
        returns: await this.returns.returnsIn(tx, investor, this.returns.today()),
        asOf: this.clock.now().toISOString(),
        currency: 'GHS',
      };
    });
  }

  capitalTransactions(actor: Actor | undefined, cursor: string | undefined, limit: number): Promise<Page<CapitalTransactionView>> {
    return this.read(actor, (tx, investor) => this.capital.transactionPageIn(tx, actor!, 'listMyCapitalTransactions', investor.id, cursor, limit));
  }

  distributions(actor: Actor | undefined, cursor: string | undefined, limit: number): Promise<Page<InvestorDistributionLineView>> {
    return this.read(actor, async (tx, investor) => {
      const binding = { operationId: 'listMyDistributions', principalId: actor!.principalId, filters: {} };
      const after = cursor === undefined ? null : (this.cursors.decode(cursor, binding)['runId'] ?? null);
      const all = await this.books.linesOfInvestor(tx, investor.id);
      const { rows, hasMore } = pageAfter(all, after === null ? null : (l) => l.runId === after, limit);
      return {
        data: rows.map((l) => ({
          runId: l.runId,
          runNo: l.runNo,
          periodStart: l.periodStart,
          periodEnd: l.periodEnd,
          unitDays: formatUnits(l.unitDaysE4),
          allocatedPesewas: json(l.allocatedPesewas),
          withheldPesewas: json(l.withheldPesewas),
          netPayablePesewas: json(l.netPayablePesewas),
          paidPesewas: json(l.paidPesewas),
          status: l.paidPesewas >= l.netPayablePesewas ? 'PAID' : l.paidPesewas > 0n ? 'PARTLY_PAID' : 'UNPAID',
          currency: 'GHS',
        })),
        page: { nextCursor: hasMore ? this.cursors.encode(binding, { runId: rows.at(-1)!.runId }) : null, limit, hasMore },
      };
    });
  }

  statement(actor: Actor | undefined, from: string | null, to: string | null): Promise<InvestorStatementView> {
    return this.read(actor, (tx, investor) => this.returns.statementIn(tx, investor, from, to));
  }

  documents(actor: Actor | undefined, cursor: string | undefined, limit: number): Promise<Page<InvestorDocumentView>> {
    return this.read(actor, (tx, investor) => this.profiles.documentPageIn(tx, actor!, 'listMyInvestorDocuments', investor.id, cursor, limit));
  }

  /** downloadMyInvestorDocument: a signed, expiring link to one of the investor's own documents, its issue logged. */
  download(actor: Actor | undefined, documentId: string): Promise<{ readonly url: string; readonly expiresAt: string }> {
    return this.read(actor, async (tx, investor) => {
      const document = await this.profiles.documentOfIn(tx, investor.id, documentId);
      if (document === null) throw new NotFoundError(`no document ${documentId} of this investor`);
      const file = await this.files.find(tx, document.fileId);
      if (file === null || file.scanStatus !== 'CLEAN') throw new NotFoundError(`document ${documentId} cannot be served`);
      const link = await this.files.signedLink(tx, file, 'INVESTOR_DOCUMENT', DOCUMENT_LINK_SECONDS);
      return { url: link.url, expiresAt: link.expiresAt.toISOString() };
    });
  }

  /** The signed-in investor's own record: an investor session whose principal an investor record holds, or 403. */
  private read<T>(actor: Actor | undefined, work: (tx: Transaction, investor: InvestorRecord) => Promise<T>): Promise<T> {
    return this.uow.run({ isolation: 'read committed' }, async (tx) => {
      if (actor === undefined) throw new UnauthenticatedError('no investor is signed in');
      const investor = actor.realm === 'INVESTOR' ? await this.books.investorByPrincipal(tx, actor.principalId) : null;
      if (investor === null) {
        await this.audit.recordDetached({ module: 'cap', action: 'AUTHORISATION_FAILURE', entityType: 'InvestorPortal', metadata: { realm: actor.realm, reason: 'NOT_AN_INVESTOR' } });
        throw new ForbiddenError('the investor portal is read by an investor about themselves');
      }
      return work(tx, investor);
    });
  }
}
