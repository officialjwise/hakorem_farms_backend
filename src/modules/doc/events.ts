/*
 * DOC's published events (docs/DOMAIN_MODEL.md section 5). Other modules import these as types only. Neither posts to
 * the ledger. Rendering runs after the issuing transaction commits (ADR-0010, FR-DOC-003).
 */

/** A document was issued and asks to be rendered and archived; DOC's worker consumer renders it once. */
export interface RenderRequested {
  readonly businessDocumentId: string;
  readonly docType: string;
  readonly documentNo: string | null;
  readonly branchId: string;
  /** The template versions active when the document was issued: a reprint keeps them (FR-BIL-010). */
  readonly templateVersionId: string;
  readonly thermalTemplateVersionId: string | null;
}

/** A document's rendering is in the archive, with the SHA-256 of its stored bytes. BIL keeps it as the content hash. */
export interface DocumentArchived {
  readonly archivedDocumentId: string;
  readonly businessDocumentId: string;
  readonly docType: string;
  readonly documentNo: string | null;
  readonly branchId: string;
  /** Hex SHA-256 of the archived PDF. */
  readonly sha256: string;
  readonly revision: number;
}
