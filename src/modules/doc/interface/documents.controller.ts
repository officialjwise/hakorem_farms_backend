import { Body, Controller, Get, Inject, Param, Post, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import type { z } from 'zod';
import type { Actor } from '../../../platform/context/request-context';
import { CurrentActor } from '../../../platform/http/actor-param';
import { IdempotencyKeyHeader, Operation } from '../../../platform/http/operation';
import { zodPipe } from '../../../platform/http/validation';
import type { StoredResponse } from '../../../platform/idempotency/idempotency';
import { Documents, type ArchivedDocumentView, type Page } from '../application/documents';
import type { SignedUrlView } from '../application/files';
import { Templates, type DocumentTemplateView, type TemplatePage, type TemplatePreviewView, type TemplateVersionView } from '../application/templates';
import { ArchivedDocumentPageQuery, DocumentDownloadRequest, IdParam, PageQuery, TemplatePreviewRequest, TemplateVersionCreate } from './schemas';

const READ = { access: 'SESSION', realms: ['STAFF'], idempotent: false, csrf: false, rateLimit: 'console' } as const;
const WRITE = { access: 'SESSION', realms: ['STAFF'], idempotent: true, csrf: true, rateLimit: 'console' } as const;

async function reply<T>(res: Response, pending: Promise<StoredResponse<T>>): Promise<T> {
  const response = await pending;
  res.status(response.status);
  return response.body;
}

/** The document archive (FR-DOC-001, FR-DOC-007). Parses and delegates. */
@Controller('documents')
export class DocumentsController {
  constructor(@Inject(Documents) private readonly documents: Documents) {}

  @Get()
  @Operation({ operationId: 'listArchivedDocuments', ...READ, permission: 'doc.document.read' })
  listArchivedDocuments(@CurrentActor() actor: Actor | undefined, @Query(zodPipe(ArchivedDocumentPageQuery)) query: z.infer<typeof ArchivedDocumentPageQuery>): Promise<Page<ArchivedDocumentView>> {
    const { cursor, limit, ...f } = query;
    return this.documents.list(
      actor,
      {
        businessDocumentId: f.businessDocumentId ?? null,
        docType: f.docType ?? null,
        documentNo: f.documentNo ?? null,
        from: f.from === undefined ? null : new Date(f.from),
        to: f.to === undefined ? null : new Date(f.to),
      },
      cursor,
      limit,
    );
  }

  @Get(':id')
  @Operation({ operationId: 'getArchivedDocument', ...READ, permission: 'doc.document.read' })
  getArchivedDocument(@CurrentActor() actor: Actor | undefined, @Param('id', zodPipe(IdParam)) id: string): Promise<ArchivedDocumentView> {
    return this.documents.get(actor, id);
  }

  @Post(':id/download')
  @Operation({ operationId: 'downloadArchivedDocument', access: 'SESSION', realms: ['STAFF'], idempotent: false, csrf: true, rateLimit: 'console', permission: 'doc.document.read' })
  async downloadArchivedDocument(
    @CurrentActor() actor: Actor | undefined,
    @Param('id', zodPipe(IdParam)) id: string,
    @Body(zodPipe(DocumentDownloadRequest)) body: z.infer<typeof DocumentDownloadRequest>,
    @Res({ passthrough: true }) res: Response,
  ): Promise<SignedUrlView> {
    res.status(200);
    return this.documents.download(actor, id, body);
  }
}

/** Document templates and their versions (FR-DOC-004). Parses and delegates. */
@Controller()
export class TemplatesController {
  constructor(@Inject(Templates) private readonly templates: Templates) {}

  @Get('document-templates')
  @Operation({ operationId: 'listDocumentTemplates', ...READ, permission: 'doc.template.read' })
  listDocumentTemplates(@CurrentActor() actor: Actor | undefined, @Query(zodPipe(PageQuery)) query: z.infer<typeof PageQuery>): Promise<TemplatePage<DocumentTemplateView>> {
    return this.templates.list(actor, query.cursor, query.limit);
  }

  @Get('document-templates/:id')
  @Operation({ operationId: 'getDocumentTemplate', ...READ, permission: 'doc.template.read' })
  getDocumentTemplate(@CurrentActor() actor: Actor | undefined, @Param('id', zodPipe(IdParam)) id: string): Promise<DocumentTemplateView> {
    return this.templates.get(actor, id);
  }

  @Get('document-templates/:id/versions')
  @Operation({ operationId: 'listTemplateVersions', ...READ, permission: 'doc.template.read' })
  listTemplateVersions(@CurrentActor() actor: Actor | undefined, @Param('id', zodPipe(IdParam)) id: string, @Query(zodPipe(PageQuery)) query: z.infer<typeof PageQuery>): Promise<TemplatePage<TemplateVersionView>> {
    return this.templates.listVersions(actor, id, query.cursor, query.limit);
  }

  @Post('document-templates/:id/versions')
  @Operation({ operationId: 'createTemplateVersion', ...WRITE, permission: 'doc.template.manage' })
  createTemplateVersion(
    @CurrentActor() actor: Actor | undefined,
    @Param('id', zodPipe(IdParam)) id: string,
    @Body(zodPipe(TemplateVersionCreate)) body: z.infer<typeof TemplateVersionCreate>,
    @IdempotencyKeyHeader() key: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<TemplateVersionView> {
    return reply(res, this.templates.createVersion(actor, id, body, key));
  }

  @Get('template-versions/:id')
  @Operation({ operationId: 'getTemplateVersion', ...READ, permission: 'doc.template.read' })
  getTemplateVersion(@CurrentActor() actor: Actor | undefined, @Param('id', zodPipe(IdParam)) id: string): Promise<TemplateVersionView> {
    return this.templates.getVersion(actor, id);
  }

  @Post('template-versions/:id/activate')
  @Operation({ operationId: 'activateTemplateVersion', ...WRITE, permission: 'doc.template.manage' })
  activateTemplateVersion(@CurrentActor() actor: Actor | undefined, @Param('id', zodPipe(IdParam)) id: string, @IdempotencyKeyHeader() key: string, @Res({ passthrough: true }) res: Response): Promise<TemplateVersionView> {
    return reply(res, this.templates.activate(actor, id, key));
  }

  @Post('template-versions/:id/preview')
  @Operation({ operationId: 'previewTemplateVersion', access: 'SESSION', realms: ['STAFF'], idempotent: false, csrf: true, rateLimit: 'console', permission: 'doc.template.read' })
  async previewTemplateVersion(
    @CurrentActor() actor: Actor | undefined,
    @Param('id', zodPipe(IdParam)) id: string,
    @Body(zodPipe(TemplatePreviewRequest)) body: z.infer<typeof TemplatePreviewRequest>,
    @Res({ passthrough: true }) res: Response,
  ): Promise<TemplatePreviewView> {
    res.status(200);
    return this.templates.preview(actor, id, body.data);
  }
}
