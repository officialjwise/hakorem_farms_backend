import type { Transaction } from '../../../platform/database/unit-of-work';

export type TemplateOutput = 'PDF_A4' | 'THERMAL_80MM' | 'THERMAL_58MM';
export type VersionStatus = 'DRAFT' | 'ACTIVE' | 'RETIRED';

export interface TemplateRecord {
  readonly id: string;
  readonly docType: string;
  readonly output: TemplateOutput;
  readonly name: string;
  readonly activeVersionId: string | null;
  readonly versionCount: number;
  readonly version: number;
}

export interface VersionRecord {
  readonly id: string;
  readonly templateId: string;
  readonly versionNo: number;
  readonly body: string;
  readonly sampleData: Record<string, unknown> | null;
  readonly status: VersionStatus;
  readonly activatedAt: Date | null;
  readonly activatedBy: string | null;
  readonly createdAt: Date;
  readonly createdBy: string;
  readonly version: number;
}

export interface ArchivedRecord {
  readonly id: string;
  readonly businessDocumentId: string;
  readonly docType: string;
  readonly documentNo: string | null;
  readonly branchId: string;
  readonly templateVersionId: string;
  readonly fileId: string;
  readonly sha256: Buffer;
  readonly thermal: { readonly templateVersionId: string; readonly fileId: string; readonly sha256: Buffer } | null;
  readonly renderData: Record<string, unknown>;
  readonly revision: number;
  readonly recordedAt: Date;
}

export interface NewArchived extends Omit<ArchivedRecord, 'recordedAt'> {
  readonly actorId: string;
}

export interface RenderJobRecord {
  readonly id: string;
  readonly businessDocumentId: string;
  readonly sourceEventRef: string;
  readonly templateVersionId: string;
  readonly thermalTemplateVersionId: string | null;
  readonly renderData: Record<string, unknown>;
  readonly status: 'QUEUED' | 'RENDERING' | 'DONE' | 'FAILED';
  readonly attempts: number;
  readonly lastError: string | null;
  readonly archivedDocumentId: string | null;
}

export interface ArchiveFilter {
  readonly branchIds: readonly string[];
  readonly businessDocumentId: string | null;
  readonly docType: string | null;
  readonly documentNo: string | null;
  readonly from: Date | null;
  readonly to: Date | null;
}

/** DOC's own tables (`doc`): templates, their versions, the archive and render jobs. */
export interface DocStore {
  templates(tx: Transaction, afterId: string | null, limit: number): Promise<TemplateRecord[]>;
  template(tx: Transaction, id: string, forUpdate?: boolean): Promise<TemplateRecord | null>;
  activeTemplate(tx: Transaction, docType: string, output: TemplateOutput): Promise<TemplateRecord | null>;
  versions(tx: Transaction, templateId: string, afterVersionNo: number | null, limit: number): Promise<VersionRecord[]>;
  version(tx: Transaction, id: string, forUpdate?: boolean): Promise<VersionRecord | null>;
  nextVersionNo(tx: Transaction, templateId: string): Promise<number>;
  insertVersion(tx: Transaction, version: Omit<VersionRecord, 'status' | 'activatedAt' | 'activatedBy' | 'createdAt' | 'version'>): Promise<void>;
  /** Retires the template's active version, activates this one and points the template at it. */
  activate(tx: Transaction, template: TemplateRecord, versionId: string, actorId: string, at: Date): Promise<void>;
  insertJob(tx: Transaction, job: Omit<RenderJobRecord, 'status' | 'attempts' | 'lastError' | 'archivedDocumentId'>): Promise<void>;
  jobBySource(tx: Transaction, sourceEventRef: string): Promise<RenderJobRecord | null>;
  jobsOf(tx: Transaction, businessDocumentIds: readonly string[]): Promise<RenderJobRecord[]>;
  jobDone(tx: Transaction, id: string, archivedDocumentId: string): Promise<void>;
  jobFailed(tx: Transaction, id: string, error: string): Promise<void>;
  insertArchived(tx: Transaction, archived: NewArchived): Promise<void>;
  archived(tx: Transaction, ids: readonly string[]): Promise<ArchivedRecord[]>;
  archivedOf(tx: Transaction, businessDocumentIds: readonly string[]): Promise<ArchivedRecord[]>;
  listArchived(tx: Transaction, filter: ArchiveFilter, afterId: string | null, limit: number): Promise<ArchivedRecord[]>;
  /** A document link made for a message (B11 continued 13): only its token's hash is stored, never the token. */
  insertLink(tx: Transaction, link: NewDocumentLink): Promise<void>;
  /** The archived rendering a live link (not expired at `at`) opens, by its token's hash; null for anything else. */
  liveLink(tx: Transaction, tokenHash: Buffer, at: Date): Promise<string | null>;
}

export interface NewDocumentLink {
  readonly id: string;
  readonly archivedDocumentId: string;
  readonly tokenHash: Buffer;
  readonly expiresAt: Date;
  readonly at: Date;
  readonly actorId: string;
}

export const DOC_STORE = Symbol('DOC_STORE');
