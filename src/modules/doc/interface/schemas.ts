import { z } from 'zod';

const Limit = z.coerce.number().int().min(1).max(100).default(25);
const Cursor = z.string().min(1).max(512).optional();

export const IdParam = z.uuid();

export const PageQuery = z.object({ cursor: Cursor, limit: Limit });

export const ArchivedDocumentPageQuery = PageQuery.extend({
  businessDocumentId: z.uuid().optional(),
  docType: z.string().regex(/^[A-Z][A-Z_]{1,39}$/).optional(),
  documentNo: z.string().min(1).max(60).optional(),
  from: z.iso.datetime({ offset: true }).optional(),
  to: z.iso.datetime({ offset: true }).optional(),
});

/** The body is checked again in the handler against the sandbox (FR-DOC-004); here only its size and shape. */
export const TemplateVersionCreate = z.strictObject({
  body: z.string().min(1).max(65_536),
  sampleData: z.record(z.string(), z.unknown()).optional(),
});

export const TemplatePreviewRequest = z.strictObject({ data: z.record(z.string(), z.unknown()).optional() });

export const DocumentDownloadRequest = z.strictObject({ reprint: z.boolean().optional() });

/** `getSharedDocument`: a document link's token, read only by its hash (B11 continued 13). */
export const DocumentLinkTokenParam = z.string().min(1).max(200);
