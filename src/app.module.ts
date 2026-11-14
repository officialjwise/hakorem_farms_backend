import { Module, type DynamicModule, type Type } from '@nestjs/common';
import type { Clock } from '@hakorem/kernel';
import type { Logger } from 'pino';
import type { AppConfig } from './platform/config/app-config';
import { PlatformModule } from './platform/platform.module';

/**
 * The modular monolith's root. Platform first; each module session (B3 onward) adds its module here and
 * nowhere else. There is no module code in B2.
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
      imports: [PlatformModule.forRoot(config, logger, clock), ...extra],
    };
  }
}
