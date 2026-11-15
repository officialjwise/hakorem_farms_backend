import { z } from 'zod';

const CalendarDate = z.iso.date();

/** The query of a dashboard tile: one branch, or every branch the grants reach. Unknown parameters are refused. */
export const TileQuery = z.strictObject({ branchId: z.uuid().optional() });

/** The query of a time series tile: a branch and a period of business dates. */
export const SeriesQuery = z.strictObject({ branchId: z.uuid().optional(), from: CalendarDate.optional(), to: CalendarDate.optional() });

/** The query of `getOwnerDashboard`: a branch and the business date. */
export const DashboardQuery = z.strictObject({ branchId: z.uuid().optional(), date: CalendarDate.optional(), period: z.enum(['WEEK', 'MONTH']).optional() });
