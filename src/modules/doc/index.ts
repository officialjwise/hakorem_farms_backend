/**
 * DOC's public door (MODULE_BOUNDARIES, DOC card). From B04e continued 2 it serves the file store's operations
 * (ADR-0044); a module that references a file reads it through the platform `FileStore`, not through DOC.
 */
export { DocModule } from './doc.module';
export { FILE_PURPOSES, type FilePurpose } from './domain/file-use';
