import { Module } from '@nestjs/common';
import type { Clock } from '@hakorem/kernel';
import { UnitOfWork } from '../../platform/database/unit-of-work';
import { CLOCK } from '../../platform/platform.module';
import { Authoriser, IamModule } from '../iam';
import { DASHBOARD_STORE, type DashboardStore } from './application/dashboard-store';
import { Dashboards } from './application/dashboards';
import { PgDashboardStore } from './infrastructure/pg-dashboard-store';
import { DashboardController } from './interface/dashboard.controller';

/**
 * RPT (layer 11): reporting and dashboards. B05x builds the owner dashboard and the tiles whose data exists, each
 * read from other modules' published views only (ADR-0011, ADR-0023); the reporting schema, its projections, report
 * runs, schedules, the daily exception report and the dashboard's caching remain B12's.
 */
@Module({
  imports: [IamModule],
  controllers: [DashboardController],
  providers: [
    { provide: DASHBOARD_STORE, useClass: PgDashboardStore },
    {
      provide: Dashboards,
      useFactory: (uow: UnitOfWork, store: DashboardStore, authoriser: Authoriser, clock: Clock) => new Dashboards(uow, store, authoriser, clock),
      inject: [UnitOfWork, DASHBOARD_STORE, Authoriser, CLOCK],
    },
  ],
  exports: [Dashboards],
})
export class RptModule {}
