/**
 * What each use of the file store accepts (FR-DOC-006, SA-11, SEC-027, security architecture section 5): the content
 * types by sniffing, the size cap, and the classification that decides who reads it and for how long a link lives
 * (docs/security/DATA_CLASSIFICATION.md, DC-34). Pure: no I/O, no framework.
 */
export const FILE_PURPOSES = [
  'PRODUCT_IMAGE',
  'PROOF_OF_DELIVERY',
  'SIGNATURE',
  'SUPPLIER_DOCUMENT',
  'SUPPLIER_INVOICE',
  'INVESTOR_DOCUMENT',
  'IMPORT',
  'EXPORT',
  'EVIDENCE',
  'STATEMENT',
  'AGREEMENT',
] as const;
export type FilePurpose = (typeof FILE_PURPOSES)[number];
export type FileClassification = 'PUBLIC' | 'CONFIDENTIAL';
export type ScanStatus = 'PENDING' | 'CLEAN' | 'INFECTED' | 'FAILED';

const MEGABYTE = 1_048_576;
/** SA-11: images 5 MB; PDF and spreadsheets 10 MB. */
export const IMAGE_CAP_BYTES = 5 * MEGABYTE;
export const DOCUMENT_CAP_BYTES = 10 * MEGABYTE;
/** The largest cap of any use: the most an upload request may carry, refused while the body is still arriving. */
export const LARGEST_CAP_BYTES = DOCUMENT_CAP_BYTES;

const JPEG = 'image/jpeg';
const PNG = 'image/png';
const WEBP = 'image/webp';
const PDF = 'application/pdf';
const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const CSV = 'text/csv';

const IMAGES = [JPEG, PNG, WEBP] as const;
const IMAGES_AND_PDF = [...IMAGES, PDF] as const;

export interface FileUse {
  readonly types: readonly string[];
  readonly classification: FileClassification;
  /** The prefix of the random storage key: the use, never anything the uploader typed. */
  readonly keyPrefix: string;
}

/**
 * Product photographs are PUBLIC once re-encoded into variants (FR-DOC-005); the original stays in the private bucket.
 * Everything else is CONFIDENTIAL (DC-34): delivery proof, signatures, supplier, investor, import and export files,
 * evidence. An EXPORT file is written by the server for a master data export (FR-MDM-020, A-128) and accepts no upload.
 */
export const FILE_USES: Readonly<Record<FilePurpose, FileUse>> = {
  PRODUCT_IMAGE: { types: IMAGES, classification: 'PUBLIC', keyPrefix: 'product-image' },
  PROOF_OF_DELIVERY: { types: IMAGES, classification: 'CONFIDENTIAL', keyPrefix: 'proof-of-delivery' },
  SIGNATURE: { types: [PNG, JPEG], classification: 'CONFIDENTIAL', keyPrefix: 'signature' },
  SUPPLIER_DOCUMENT: { types: IMAGES_AND_PDF, classification: 'CONFIDENTIAL', keyPrefix: 'supplier-document' },
  SUPPLIER_INVOICE: { types: IMAGES_AND_PDF, classification: 'CONFIDENTIAL', keyPrefix: 'supplier-invoice' },
  INVESTOR_DOCUMENT: { types: IMAGES_AND_PDF, classification: 'CONFIDENTIAL', keyPrefix: 'investor-document' },
  IMPORT: { types: [XLSX, CSV], classification: 'CONFIDENTIAL', keyPrefix: 'import' },
  EXPORT: { types: [], classification: 'CONFIDENTIAL', keyPrefix: 'export' },
  EVIDENCE: { types: IMAGES_AND_PDF, classification: 'CONFIDENTIAL', keyPrefix: 'evidence' },
  STATEMENT: { types: [PDF], classification: 'CONFIDENTIAL', keyPrefix: 'statement' },
  AGREEMENT: { types: [PDF], classification: 'CONFIDENTIAL', keyPrefix: 'agreement' },
};

/** SA-11's cap for a sniffed type: images 5 MB, everything else (PDF, spreadsheets) 10 MB. */
export function capFor(contentType: string): number {
  return (IMAGES as readonly string[]).includes(contentType) ? IMAGE_CAP_BYTES : DOCUMENT_CAP_BYTES;
}

export type UploadJudgement =
  | { readonly allowed: true; readonly use: FileUse }
  | { readonly allowed: false; readonly refusal: 'FILE_TYPE_NOT_ALLOWED' | 'PAYLOAD_TOO_LARGE' | 'EMPTY_FILE' };

/** Whether content of this sniffed type and size may be stored for this use. A type nobody recognised is null. */
export function judgeUpload(purpose: FilePurpose, sniffedType: string | null, sizeBytes: number): UploadJudgement {
  if (sizeBytes === 0) return { allowed: false, refusal: 'EMPTY_FILE' };
  const use = FILE_USES[purpose];
  if (sniffedType === null || !use.types.includes(sniffedType)) return { allowed: false, refusal: 'FILE_TYPE_NOT_ALLOWED' };
  if (sizeBytes > capFor(sniffedType)) return { allowed: false, refusal: 'PAYLOAD_TOO_LARGE' };
  return { allowed: true, use };
}

/** Only a CLEAN file is ever served or linked (FR-DOC-006); PENDING is shown to its readers but never served. */
export function isServable(status: ScanStatus): boolean {
  return status === 'CLEAN';
}

/** INFECTED and FAILED files are quarantined: not even their metadata is shown (SEC-027). */
export function isQuarantined(status: ScanStatus): boolean {
  return status === 'INFECTED' || status === 'FAILED';
}
