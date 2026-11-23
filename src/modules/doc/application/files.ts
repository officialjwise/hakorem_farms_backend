import type { Actor } from '../../../platform/context/request-context';
import type { Transaction, UnitOfWork } from '../../../platform/database/unit-of-work';
import { ApiError, BusinessRuleError, NotFoundError, PayloadTooLargeError, ValidationFailedError } from '../../../platform/errors/api-error';
import { registerMessages, translate } from '../../../platform/i18n/messages';
import type { Idempotency, StoredResponse } from '../../../platform/idempotency/idempotency';
import { sniffContentType } from '../../../platform/storage/content-sniffer';
import type { FileStore, StoredFileRecord } from '../../../platform/storage/file-store';
import type { Authoriser } from '../../iam';
import { isQuarantined, isServable, judgeUpload, type FilePurpose, type ScanStatus } from '../domain/file-use';

registerMessages({
  'doc.file_type_not_allowed': 'This kind of file cannot be used here. Check what this upload accepts and try another file.',
  'doc.file_not_clean': 'This file has not passed its virus check, so it cannot be opened.',
  'doc.file_empty': 'The file is empty.',
});

/** 415: the sniffed content type is not on this use's allow-list (docs/API.md section 10). */
export class FileTypeNotAllowedError extends ApiError {
  readonly status = 415;
  readonly code = 'FILE_TYPE_NOT_ALLOWED';
  readonly messageKey = 'doc.file_type_not_allowed';
}

/** 422: the file has not passed its malware scan, or failed it, and is not served. */
export class FileNotCleanError extends BusinessRuleError {
  readonly code = 'FILE_NOT_CLEAN';
  readonly messageKey = 'doc.file_not_clean';
}

/** The contract's `StoredFile`. */
export interface StoredFileView {
  readonly id: string;
  readonly originalName: string;
  readonly contentType: string;
  readonly sizeBytes: number;
  readonly purpose: string;
  readonly classification: string;
  readonly scanStatus: ScanStatus;
  readonly createdAt: string;
}

export interface SignedUrlView {
  readonly url: string;
  readonly expiresAt: string;
}

export interface UploadedContent {
  readonly content: Buffer;
  readonly originalName: string;
}

const UPLOAD = 'platform.file.upload';
/** Uploads an EVIDENCE file and nothing else: the Farm hand's death photograph (owner, 2026-11-15; B06r, ADR-0053). */
const UPLOAD_EVIDENCE = 'platform.file.upload.evidence';
const EVIDENCE: FilePurpose = 'EVIDENCE';
/** The Driver's: a proof-of-delivery photograph or a signature and nothing else (CR-056 item 1, migration 0300). */
const UPLOAD_PROOF = 'platform.file.upload.proof';
const PROOF_PURPOSES: ReadonlySet<FilePurpose> = new Set<FilePurpose>(['PROOF_OF_DELIVERY', 'SIGNATURE']);
const READ = 'platform.file.read';
const READ_ANY = 'platform.file.read.any';
const OWNER_MODULE = 'doc';

function view(file: StoredFileRecord): StoredFileView {
  return {
    id: file.id,
    originalName: file.originalName,
    contentType: file.contentType,
    sizeBytes: file.sizeBytes,
    purpose: file.purpose,
    classification: file.classification,
    scanStatus: file.scanStatus,
    createdAt: file.createdAt.toISOString(),
  };
}

/**
 * The file store's operations (FR-DOC-006, FR-DOC-007, SEC-027, ADR-0044). Each authorises first, deny by default:
 * uploading needs `platform.file.upload`, or for an EVIDENCE file alone `platform.file.upload.evidence` (ADR-0053),
 * which opens no other use; reading or linking needs `platform.file.read` and, for a file someone else
 * uploaded, `platform.file.read.any`. Uploads are typed by their bytes against the use's allow-list and capped by
 * SA-11; a quarantined file is never shown, and only a CLEAN one is linked, by a link that expires and is logged.
 */
export class Files {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly store: FileStore,
    private readonly authoriser: Authoriser,
    private readonly idempotency: Idempotency,
    private readonly signedUrlTtlSeconds: number,
  ) {}

  async uploadFile(actor: Actor | undefined, purpose: FilePurpose, upload: UploadedContent, idempotencyKey: string): Promise<StoredResponse<StoredFileView>> {
    // Nothing reaches storage before the permission is checked.
    await this.uow.run({ isolation: 'read committed' }, (tx) => this.authoriseUpload(tx, actor, purpose));
    const sniffed = sniffContentType(upload.content);
    const judgement = judgeUpload(purpose, sniffed, upload.content.length);
    if (!judgement.allowed) {
      switch (judgement.refusal) {
        case 'EMPTY_FILE':
          throw new ValidationFailedError('the uploaded file is empty', [{ field: '/file', code: 'REQUIRED', message: translate('doc.file_empty') }]);
        case 'PAYLOAD_TOO_LARGE':
          throw new PayloadTooLargeError(`a ${sniffed} of ${upload.content.length} bytes is over the ${purpose} cap`);
        case 'FILE_TYPE_NOT_ALLOWED':
          throw new FileTypeNotAllowedError(`${purpose} does not accept ${sniffed ?? 'unrecognised content'}`);
      }
    }
    const contentType = sniffed!;
    const object = await this.store.put(judgement.use.keyPrefix, upload.content, contentType);
    return this.uow.run({ isolation: 'serializable' }, async (tx) => {
      await this.authoriseUpload(tx, actor, purpose);
      const request = { purpose, sha256: object.sha256.toString('hex'), sizeBytes: object.sizeBytes, originalName: upload.originalName };
      const claim = await this.idempotency.claim(tx, { operationId: 'uploadFile', principalId: actor!.principalId, key: idempotencyKey, request });
      // A replay leaves the object just written unreferenced in the private bucket, where it is never served.
      if (claim.kind === 'REPLAY') return claim.response as StoredResponse<StoredFileView>;
      const stored = await this.store.register(tx, {
        object,
        originalName: upload.originalName,
        contentType,
        purpose,
        classification: judgement.use.classification,
        ownerModule: OWNER_MODULE,
        actorId: actor!.principalId,
      });
      const response = { status: 201, body: view(stored) };
      await this.idempotency.complete(tx, claim.id, response);
      return response;
    });
  }

  /**
   * Deny by default: any use needs `platform.file.upload`; an EVIDENCE file is also allowed to a holder of
   * `platform.file.upload.evidence` alone, and a PROOF_OF_DELIVERY photograph or a SIGNATURE to a holder of
   * `platform.file.upload.proof` alone (the Driver, B11 continued). A holder of either alone asking for any other use is
   * refused on `platform.file.upload`, which they do not hold, and the refusal is audited as any other.
   */
  private async authoriseUpload(tx: Transaction, actor: Actor | undefined, purpose: FilePurpose): Promise<void> {
    const narrow = purpose === EVIDENCE ? UPLOAD_EVIDENCE : PROOF_PURPOSES.has(purpose) ? UPLOAD_PROOF : null;
    const narrowOnly = narrow !== null && actor !== undefined && !(await this.authoriser.holds(tx, actor, UPLOAD));
    await this.authoriser.authorise(tx, actor, narrowOnly ? narrow : UPLOAD);
  }

  getFile(actor: Actor | undefined, id: string): Promise<StoredFileView> {
    return this.uow.run({ isolation: 'read committed' }, async (tx) => view(await this.readable(tx, actor, id)));
  }

  /** A link for a CLEAN file, expiring after the configured lifetime (five minutes, SA-04), with its access log row. */
  createFileSignedUrl(actor: Actor | undefined, id: string): Promise<SignedUrlView> {
    return this.uow.run({ isolation: 'read committed' }, async (tx) => {
      const file = await this.readable(tx, actor, id);
      if (!isServable(file.scanStatus)) {
        throw new FileNotCleanError(`file ${id} is ${file.scanStatus}`);
      }
      const link = await this.store.signedLink(tx, file, 'createFileSignedUrl', this.signedUrlTtlSeconds);
      return { url: link.url, expiresAt: link.expiresAt.toISOString() };
    });
  }

  /** The permission, the record, then whose it is; a quarantined file is refused to everyone. */
  private async readable(tx: Transaction, actor: Actor | undefined, id: string): Promise<StoredFileRecord> {
    await this.authoriser.authorise(tx, actor, READ);
    const file = await this.store.find(tx, id);
    if (file === null) throw new NotFoundError(`no file ${id}`);
    await this.authoriser.authorise(tx, actor, READ, { owner: { principalId: file.createdBy, anyPermission: READ_ANY } });
    if (isQuarantined(file.scanStatus)) {
      throw new FileNotCleanError(`file ${id} is ${file.scanStatus}`);
    }
    return file;
  }
}
