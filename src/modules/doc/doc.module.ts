import { Inject, Module, type OnModuleInit } from '@nestjs/common';
import type { Clock } from '@hakorem/kernel';
import type { Logger } from 'pino';
import { AuditTrail } from '../../platform/audit/audit-trail';
import { APP_CONFIG, type AppConfig } from '../../platform/config/app-config';
import { UnitOfWork } from '../../platform/database/unit-of-work';
import { DomainEvents } from '../../platform/events/domain-events';
import { Cursors } from '../../platform/http/cursor';
import { Idempotency } from '../../platform/idempotency/idempotency';
import { CLOCK, LOGGER } from '../../platform/platform.module';
import { FileStore } from '../../platform/storage/file-store';
import { Authoriser, IamModule, PRINCIPAL_NAMES, type PrincipalNames } from '../iam';
import { DOC_STORE, type DocStore } from './application/doc-store';
import { Documents } from './application/documents';
import { Files } from './application/files';
import { Templates } from './application/templates';
import { PgDocStore } from './infrastructure/pg-doc-store';
import { DocumentsController, SharedDocumentsController, TemplatesController } from './interface/documents.controller';
import { FilesController } from './interface/files.controller';

/**
 * DOC (layer 3): the file store's operations over the platform mechanism (ADR-0044), and from B08 continued 2b the
 * document templates, rendering after commit through the outbox, and the immutable archive (ADR-0061). A module that
 * issues a document asks for its rendering with `Documents.requestRenderIn` in its own transaction; the worker's
 * consumer renders and archives it once.
 */
@Module({
  imports: [IamModule],
  controllers: [FilesController, DocumentsController, SharedDocumentsController, TemplatesController],
  providers: [
    { provide: DOC_STORE, useClass: PgDocStore },
    {
      provide: Files,
      useFactory: (uow: UnitOfWork, store: FileStore, authoriser: Authoriser, idempotency: Idempotency, config: AppConfig) =>
        new Files(uow, store, authoriser, idempotency, config.SIGNED_URL_TTL_SECONDS),
      inject: [UnitOfWork, FileStore, Authoriser, Idempotency, APP_CONFIG],
    },
    {
      provide: Documents,
      useFactory: (uow: UnitOfWork, store: DocStore, files: FileStore, events: DomainEvents, authoriser: Authoriser, cursors: Cursors, clock: Clock, config: AppConfig, logger: Logger) =>
        new Documents(uow, store, files, events, authoriser, cursors, clock, config.SIGNED_URL_TTL_SECONDS, logger),
      inject: [UnitOfWork, DOC_STORE, FileStore, DomainEvents, Authoriser, Cursors, CLOCK, APP_CONFIG, LOGGER],
    },
    {
      provide: Templates,
      useFactory: (uow: UnitOfWork, store: DocStore, principals: PrincipalNames, authoriser: Authoriser, idempotency: Idempotency, audit: AuditTrail, cursors: Cursors, clock: Clock) =>
        new Templates(uow, store, principals, authoriser, idempotency, audit, cursors, clock),
      inject: [UnitOfWork, DOC_STORE, PRINCIPAL_NAMES, Authoriser, Idempotency, AuditTrail, Cursors, CLOCK],
    },
  ],
  exports: [Files, Documents],
})
export class DocModule implements OnModuleInit {
  constructor(
    @Inject(DomainEvents) private readonly events: DomainEvents,
    @Inject(Documents) private readonly documents: Documents,
  ) {}

  /** Registers the render consumer: the worker's dispatcher delivers `doc.RenderRequested` to it after commit. */
  onModuleInit(): void {
    this.events.registerConsumer(this.documents.renderConsumer);
  }
}
