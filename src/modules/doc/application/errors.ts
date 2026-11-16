import { BusinessRuleError } from '../../../platform/errors/api-error';
import { registerMessages, translate } from '../../../platform/i18n/messages';
import type { BrokenTemplateRule } from '../domain/templates';

registerMessages({
  'doc.template_body_invalid': 'This template cannot be saved: it uses something a template may not.',
  'doc.document_not_archived': 'This document has not been rendered and archived yet. Try again in a moment.',
  'doc.preview_data_required': 'This version has no sample data. Give the data to preview it with.',
  'doc.archive_hash_mismatch': 'The archived copy of this document does not match its fingerprint, so it is not served. Support has been alerted.',
});

/** 422 TEMPLATE_BODY_INVALID (FR-DOC-004): every rule the body breaks, each in `details[].code`. */
export class TemplateBodyRefusedError extends BusinessRuleError {
  readonly code = 'TEMPLATE_BODY_INVALID';
  readonly messageKey = 'doc.template_body_invalid';
  constructor(broken: readonly BrokenTemplateRule[]) {
    super(`template body refused: ${broken.map((b) => b.rule).join(', ')}`, broken.map((b) => ({ field: '/body', code: b.rule, message: b.detail })));
  }
}

/** 422 DOCUMENT_NOT_ARCHIVED (FR-DOC-003): still rendering, its file not yet scanned, or no thermal rendition. */
export class DocumentNotArchivedError extends BusinessRuleError {
  readonly code = 'DOCUMENT_NOT_ARCHIVED';
  readonly messageKey = 'doc.document_not_archived';
  constructor(reason: 'RENDERING' | 'NOT_SCANNED' | 'NO_THERMAL_RENDITION') {
    super(`the document is not archived: ${reason}`, [{ field: null, code: reason, message: translate('doc.document_not_archived') }]);
  }
}

/** 422 ARCHIVE_HASH_MISMATCH (FR-BIL-003, FR-DOC-001): the stored bytes are not the ones archived; never served. */
export class ArchiveHashMismatchError extends BusinessRuleError {
  readonly code = 'ARCHIVE_HASH_MISMATCH';
  readonly messageKey = 'doc.archive_hash_mismatch';
  constructor(archivedDocumentId: string) {
    super(`archived document ${archivedDocumentId}: the stored bytes do not hash to the archived SHA-256`, [{ field: null, code: 'HASH_MISMATCH', message: translate('doc.archive_hash_mismatch') }]);
  }
}

/** 422 PREVIEW_DATA_REQUIRED (FR-DOC-004, ADR-0062): no data in the request and none saved with the version. */
export class PreviewDataRequiredError extends BusinessRuleError {
  readonly code = 'PREVIEW_DATA_REQUIRED';
  readonly messageKey = 'doc.preview_data_required';
  constructor(versionId: string) {
    super(`template version ${versionId} has no sample data and none was given`, [{ field: '/data', code: 'PREVIEW_DATA_REQUIRED', message: translate('doc.preview_data_required') }]);
  }
}
