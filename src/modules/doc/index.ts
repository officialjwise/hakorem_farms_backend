/**
 * DOC's public door (MODULE_BOUNDARIES, DOC card). From B04e continued 2 it serves the file store's operations
 * (ADR-0044); a module that references a file reads it through the platform `FileStore`, not through DOC. From B08
 * continued 2b `Documents` is the archive: `requestRenderIn` (in the issuing transaction), `archivedIn` and `content`
 * (the archived bytes, hash-checked) for a module that reprints or audits its documents (ADR-0061). Events: `events.ts`.
 */
export { DocModule } from './doc.module';
export { FILE_PURPOSES, type FilePurpose } from './domain/file-use';
export { Documents, DOCUMENT_ARCHIVED, DOCUMENT_LINK_PREFIX, LINK_NOT_READY, type DocumentAttachment, type LinkNotReady, type RenderRequest, type SharedDocumentView } from './application/documents';
export type { ArchivedRecord } from './application/doc-store';
export { ArchiveHashMismatchError, DocumentNotArchivedError } from './application/errors';
export { PLATFORM_RENDERER, type DocumentRenderer } from './application/rendering';
export type { DocumentArchived, RenderRequested } from './events';
