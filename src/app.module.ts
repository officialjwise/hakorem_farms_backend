import { Module, type DynamicModule, type Type } from '@nestjs/common';
import type { Clock } from '@hakorem/kernel';
import type { Logger } from 'pino';
import type { AppConfig } from './platform/config/app-config';
import { IamModule } from './modules/iam';
import { MdmModule } from './modules/mdm';
import { PlatformModule } from './platform/platform.module';

/**
 * The modular monolith's root. Platform first, then the modules from the lowest layer up; each module session adds
 * its module here and nowhere else.
 */
@Module({})
export class AppModule {
  static forRoot(
    config: AppConfig,
    logger: Logger,
    clock?: Clock,
    extra: ReadonlyArray<DynamicModule | Type> = [],
  ): DynamicModule {
    return {
      module: AppModule,
      imports: [PlatformModule.forRoot(config, logger, clock), IamModule, MdmModule, ...extra],
    };
  }
}
