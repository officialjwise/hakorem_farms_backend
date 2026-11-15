import { Module } from '@nestjs/common';
import { APP_CONFIG, type AppConfig } from '../../platform/config/app-config';
import { UnitOfWork } from '../../platform/database/unit-of-work';
import { Idempotency } from '../../platform/idempotency/idempotency';
import { FileStore } from '../../platform/storage/file-store';
import { Authoriser, IamModule } from '../iam';
import { Files } from './application/files';
import { FilesController } from './interface/files.controller';

/**
 * DOC (layer 3): from B04e continued 2, the file store's operations over the platform mechanism (ADR-0044): which
 * uses exist, what each accepts and who may read. Document templates, rendering and the archive arrive in B8.
 */
@Module({
  imports: [IamModule],
  controllers: [FilesController],
  providers: [
    {
      provide: Files,
      useFactory: (uow: UnitOfWork, store: FileStore, authoriser: Authoriser, idempotency: Idempotency, config: AppConfig) =>
        new Files(uow, store, authoriser, idempotency, config.SIGNED_URL_TTL_SECONDS),
      inject: [UnitOfWork, FileStore, Authoriser, Idempotency, APP_CONFIG],
    },
  ],
  exports: [Files],
})
export class DocModule {}
