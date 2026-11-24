import type { Transaction } from '../../../platform/database/unit-of-work';
import type { ArchiveFilter, ArchivedRecord, DocStore, NewArchived, NewDocumentLink, RenderJobRecord, TemplateOutput, TemplateRecord, VersionRecord } from '../application/doc-store';

const TEMPLATE_COLUMNS = `t.id, t.doc_type, t.output, t.name, t.active_version_id, t.version,
  (SELECT count(*) FROM doc.template_version v WHERE v.template_id = t.id)::int AS version_count`;
const VERSION_COLUMNS = 'id, template_id, version_no, body, sample_data, status, activated_at, activated_by, created_at, created_by, version';
const ARCHIVE_COLUMNS = `id, business_document_id, doc_type, document_no, branch_id, template_version_id, file_id, sha256,
  thermal_template_version_id, thermal_file_id, thermal_sha256, render_data, revision, recorded_at`;
const JOB_COLUMNS = 'id, business_document_id, source_event_ref, template_version_id, thermal_template_version_id, render_data, status, attempts, last_error, archived_document_id';

interface TemplateRow {
  id: string;
  doc_type: string;
  output: TemplateOutput;
  name: string;
  active_version_id: string | null;
  version: number;
  version_count: number;
}

interface VersionRow {
  id: string;
  template_id: string;
  version_no: number;
  body: string;
  sample_data: Record<string, unknown> | null;
  status: VersionRecord['status'];
  activated_at: Date | null;
  activated_by: string | null;
  created_at: Date;
  created_by: string;
  version: number;
}

interface ArchiveRow {
  id: string;
  business_document_id: string;
  doc_type: string;
  document_no: string | null;
  branch_id: string;
  template_version_id: string;
  file_id: string;
  sha256: Buffer;
  thermal_template_version_id: string | null;
  thermal_file_id: string | null;
  thermal_sha256: Buffer | null;
  render_data: Record<string, unknown>;
  revision: number;
  recorded_at: Date;
}

interface JobRow {
  id: string;
  business_document_id: string;
  source_event_ref: string;
  template_version_id: string;
  thermal_template_version_id: string | null;
  render_data: Record<string, unknown>;
  status: RenderJobRecord['status'];
  attempts: number;
  last_error: string | null;
  archived_document_id: string | null;
}

const template = (r: TemplateRow): TemplateRecord => ({
  id: r.id,
  docType: r.doc_type,
  output: r.output,
  name: r.name,
  activeVersionId: r.active_version_id,
  versionCount: r.version_count,
  version: r.version,
});

const version = (r: VersionRow): VersionRecord => ({
  id: r.id,
  templateId: r.template_id,
  versionNo: r.version_no,
  body: r.body,
  sampleData: r.sample_data,
  status: r.status,
  activatedAt: r.activated_at,
  activatedBy: r.activated_by,
  createdAt: r.created_at,
  createdBy: r.created_by,
  version: r.version,
});

const archived = (r: ArchiveRow): ArchivedRecord => ({
  id: r.id,
  businessDocumentId: r.business_document_id,
  docType: r.doc_type,
  documentNo: r.document_no,
  branchId: r.branch_id,
  templateVersionId: r.template_version_id,
  fileId: r.file_id,
  sha256: r.sha256,
  thermal: r.thermal_file_id === null ? null : { templateVersionId: r.thermal_template_version_id!, fileId: r.thermal_file_id, sha256: r.thermal_sha256! },
  renderData: r.render_data,
  revision: r.revision,
  recordedAt: r.recorded_at,
});

const job = (r: JobRow): RenderJobRecord => ({
  id: r.id,
  businessDocumentId: r.business_document_id,
  sourceEventRef: r.source_event_ref,
  templateVersionId: r.template_version_id,
  thermalTemplateVersionId: r.thermal_template_version_id,
  renderData: r.render_data,
  status: r.status,
  attempts: r.attempts,
  lastError: r.last_error,
  archivedDocumentId: r.archived_document_id,
});

/** DOC's SQL, over its own schema only (MODULE_BOUNDARIES rule 7). */
export class PgDocStore implements DocStore {
  async templates(tx: Transaction, afterId: string | null, limit: number): Promise<TemplateRecord[]> {
    const { rows } = await tx.query<TemplateRow>(
      `SELECT ${TEMPLATE_COLUMNS} FROM doc.template t WHERE t.deleted_at IS NULL AND ($1::uuid IS NULL OR t.id > $1) ORDER BY t.id LIMIT $2`,
      [afterId, limit],
    );
    return rows.map(template);
  }

  async template(tx: Transaction, id: string, forUpdate = false): Promise<TemplateRecord | null> {
    const { rows } = await tx.query<TemplateRow>(`SELECT ${TEMPLATE_COLUMNS} FROM doc.template t WHERE t.id = $1 AND t.deleted_at IS NULL${forUpdate ? ' FOR UPDATE' : ''}`, [id]);
    return rows.length === 0 ? null : template(rows[0]!);
  }

  async activeTemplate(tx: Transaction, docType: string, output: TemplateOutput): Promise<TemplateRecord | null> {
    const { rows } = await tx.query<TemplateRow>(
      `SELECT ${TEMPLATE_COLUMNS} FROM doc.template t WHERE t.doc_type = $1 AND t.output = $2 AND t.deleted_at IS NULL AND t.active_version_id IS NOT NULL`,
      [docType, output],
    );
    return rows.length === 0 ? null : template(rows[0]!);
  }

  async versions(tx: Transaction, templateId: string, afterVersionNo: number | null, limit: number): Promise<VersionRecord[]> {
    const { rows } = await tx.query<VersionRow>(
      `SELECT ${VERSION_COLUMNS} FROM doc.template_version WHERE template_id = $1 AND ($2::int IS NULL OR version_no < $2) ORDER BY version_no DESC LIMIT $3`,
      [templateId, afterVersionNo, limit],
    );
    return rows.map(version);
  }

  async version(tx: Transaction, id: string, forUpdate = false): Promise<VersionRecord | null> {
    const { rows } = await tx.query<VersionRow>(`SELECT ${VERSION_COLUMNS} FROM doc.template_version WHERE id = $1${forUpdate ? ' FOR UPDATE' : ''}`, [id]);
    return rows.length === 0 ? null : version(rows[0]!);
  }

  async nextVersionNo(tx: Transaction, templateId: string): Promise<number> {
    const { rows } = await tx.query<{ next: number }>('SELECT COALESCE(max(version_no), 0)::int + 1 AS next FROM doc.template_version WHERE template_id = $1', [templateId]);
    return rows[0]!.next;
  }

  async insertVersion(tx: Transaction, v: Omit<VersionRecord, 'status' | 'activatedAt' | 'activatedBy' | 'createdAt' | 'version'>): Promise<void> {
    await tx.query(
      `INSERT INTO doc.template_version (id, template_id, version_no, body, sample_data, status, created_by, updated_by)
       VALUES ($1, $2, $3, $4, $5, 'DRAFT', $6, $6)`,
      [v.id, v.templateId, v.versionNo, v.body, v.sampleData === null ? null : JSON.stringify(v.sampleData), v.createdBy],
    );
  }

  async activate(tx: Transaction, t: TemplateRecord, versionId: string, actorId: string, at: Date): Promise<void> {
    await tx.query(
      `UPDATE doc.template_version SET status = 'RETIRED', version = version + 1, updated_at = $3, updated_by = $2
        WHERE template_id = $1 AND status = 'ACTIVE'`,
      [t.id, actorId, at],
    );
    await tx.query(
      `UPDATE doc.template_version SET status = 'ACTIVE', activated_at = $3, activated_by = $2, version = version + 1, updated_at = $3, updated_by = $2
        WHERE id = $1`,
      [versionId, actorId, at],
    );
    await tx.query('UPDATE doc.template SET active_version_id = $2, version = version + 1, updated_at = $4, updated_by = $3 WHERE id = $1', [t.id, versionId, actorId, at]);
  }

  async insertJob(tx: Transaction, j: Omit<RenderJobRecord, 'status' | 'attempts' | 'lastError' | 'archivedDocumentId'>): Promise<void> {
    await tx.query(
      `INSERT INTO doc.render_job (id, business_document_id, source_event_ref, template_version_id, thermal_template_version_id, render_data)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [j.id, j.businessDocumentId, j.sourceEventRef, j.templateVersionId, j.thermalTemplateVersionId, JSON.stringify(j.renderData)],
    );
  }

  async jobBySource(tx: Transaction, sourceEventRef: string): Promise<RenderJobRecord | null> {
    const { rows } = await tx.query<JobRow>(`SELECT ${JOB_COLUMNS} FROM doc.render_job WHERE source_event_ref = $1`, [sourceEventRef]);
    return rows.length === 0 ? null : job(rows[0]!);
  }

  async jobsOf(tx: Transaction, businessDocumentIds: readonly string[]): Promise<RenderJobRecord[]> {
    if (businessDocumentIds.length === 0) return [];
    const { rows } = await tx.query<JobRow>(`SELECT ${JOB_COLUMNS} FROM doc.render_job WHERE business_document_id = ANY($1::uuid[]) ORDER BY id`, [businessDocumentIds]);
    return rows.map(job);
  }

  async jobDone(tx: Transaction, id: string, archivedDocumentId: string): Promise<void> {
    await tx.query(`UPDATE doc.render_job SET status = 'DONE', attempts = attempts + 1, last_error = NULL, archived_document_id = $2, updated_at = now() WHERE id = $1`, [id, archivedDocumentId]);
  }

  async jobFailed(tx: Transaction, id: string, error: string): Promise<void> {
    await tx.query(`UPDATE doc.render_job SET status = 'FAILED', attempts = attempts + 1, last_error = $2, updated_at = now() WHERE id = $1 AND status <> 'DONE'`, [id, error.slice(0, 500)]);
  }

  async insertArchived(tx: Transaction, a: NewArchived): Promise<void> {
    await tx.query(
      `INSERT INTO doc.archived_document (id, business_document_id, doc_type, document_no, branch_id, template_version_id, file_id, sha256,
                                          thermal_template_version_id, thermal_file_id, thermal_sha256, render_data, revision, actor_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
      [
        a.id,
        a.businessDocumentId,
        a.docType,
        a.documentNo,
        a.branchId,
        a.templateVersionId,
        a.fileId,
        a.sha256,
        a.thermal?.templateVersionId ?? null,
        a.thermal?.fileId ?? null,
        a.thermal?.sha256 ?? null,
        JSON.stringify(a.renderData),
        a.revision,
        a.actorId,
      ],
    );
  }

  async archived(tx: Transaction, ids: readonly string[]): Promise<ArchivedRecord[]> {
    if (ids.length === 0) return [];
    const { rows } = await tx.query<ArchiveRow>(`SELECT ${ARCHIVE_COLUMNS} FROM doc.archived_document WHERE id = ANY($1::uuid[]) ORDER BY id`, [ids]);
    return rows.map(archived);
  }

  async archivedOf(tx: Transaction, businessDocumentIds: readonly string[]): Promise<ArchivedRecord[]> {
    if (businessDocumentIds.length === 0) return [];
    const { rows } = await tx.query<ArchiveRow>(`SELECT ${ARCHIVE_COLUMNS} FROM doc.archived_document WHERE business_document_id = ANY($1::uuid[]) ORDER BY id`, [businessDocumentIds]);
    return rows.map(archived);
  }

  async listArchived(tx: Transaction, f: ArchiveFilter, afterId: string | null, limit: number): Promise<ArchivedRecord[]> {
    const { rows } = await tx.query<ArchiveRow>(
      `SELECT ${ARCHIVE_COLUMNS} FROM doc.archived_document
        WHERE branch_id = ANY($1::uuid[])
          AND ($2::uuid IS NULL OR business_document_id = $2)
          AND ($3::text IS NULL OR doc_type = $3)
          AND ($4::text IS NULL OR document_no = $4)
          AND ($5::timestamptz IS NULL OR recorded_at >= $5)
          AND ($6::timestamptz IS NULL OR recorded_at < $6)
          AND ($7::uuid IS NULL OR id < $7)
        ORDER BY id DESC LIMIT $8`,
      [f.branchIds, f.businessDocumentId, f.docType, f.documentNo, f.from, f.to, afterId, limit],
    );
    return rows.map(archived);
  }

  async insertLink(tx: Transaction, l: NewDocumentLink): Promise<void> {
    await tx.query('INSERT INTO doc.document_link (id, archived_document_id, token_hash, expires_at, recorded_at, actor_id) VALUES ($1, $2, $3, $4, $5, $6)', [
      l.id,
      l.archivedDocumentId,
      l.tokenHash,
      l.expiresAt,
      l.at,
      l.actorId,
    ]);
  }

  async liveLink(tx: Transaction, tokenHash: Buffer, at: Date): Promise<string | null> {
    const { rows } = await tx.query<{ archived_document_id: string }>('SELECT archived_document_id FROM doc.document_link WHERE token_hash = $1 AND expires_at > $2', [tokenHash, at]);
    return rows[0]?.archived_document_id ?? null;
  }
}
