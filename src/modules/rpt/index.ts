/**
 * RPT's public door (MODULE_BOUNDARIES, RPT card). No other module uses RPT's interface; the application module
 * imports the Nest module. B05x adds the owner dashboard and its tiles over published views.
 */
export { RptModule } from './rpt.module';
export { Dashboards, type OwnerDashboardView } from './application/dashboards';
