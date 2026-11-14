import { Controller, Get, Inject } from '@nestjs/common';
import { ServiceUnavailableError } from '../errors/api-error';
import { translate } from '../i18n/messages';
import { Operation } from '../http/operation';
import { HealthService, type HealthReport } from './health.service';

/** A dependency the health report found down, listed in the 503 envelope's details. */
export class DependencyDownError extends ServiceUnavailableError {}

/**
 * `GET /v1/health` (operationId `getHealth`): public, in the health rate-limit group, answered from a short cache.
 * From B3 its contract definition is the code's (ADR-0031); the response shape is checked against the contract.
 */
@Controller('health')
export class HealthController {
  constructor(@Inject(HealthService) private readonly health: HealthService) {}

  @Get()
  @Operation({ operationId: 'getHealth', access: 'PUBLIC', realms: [], permission: null, idempotent: false, csrf: false, rateLimit: 'health' })
  async getHealth(): Promise<HealthReport> {
    const report = await this.health.report();
    if (report.status === 'DOWN') {
      const down = report.checks.filter((check) => check.status === 'DOWN');
      throw new DependencyDownError(
        'a dependency is down',
        down.map((check) => ({ field: null, code: `${check.name.toUpperCase()}_DOWN`, message: translate('error.dependency_down') })),
      );
    }
    return report;
  }
}
