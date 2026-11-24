import { z } from 'zod';
import { EXCEPTION_KINDS } from '../domain/exception-kinds';

const CalendarDate = z.iso.date();

/** The query of a dashboard tile: one branch, or every branch the grants reach. Unknown parameters are refused. */
export const TileQuery = z.strictObject({ branchId: z.uuid().optional() });

/** The query of a time series tile: a branch and a period of business dates. */
export const SeriesQuery = z.strictObject({ branchId: z.uuid().optional(), from: CalendarDate.optional(), to: CalendarDate.optional() });

/** The query of a one-day tile: a branch and the business date. */
export const DayQuery = z.strictObject({ branchId: z.uuid().optional(), date: CalendarDate.optional() });

/** The query of `getOwnerDashboard`: a branch and the business date. */
export const DashboardQuery = z.strictObject({ branchId: z.uuid().optional(), date: CalendarDate.optional(), period: z.enum(['WEEK', 'MONTH']).optional() });

const ExceptionKindValue = z.enum(EXCEPTION_KINDS);
const SeverityValue = z.enum(['INFO', 'REVIEW', 'URGENT']);
const BooleanQuery = z.enum(['true', 'false']).transform((value) => value === 'true');

/** `getDailyExceptionReport`: the business date, and one branch or every branch the grants reach. */
export const DailyExceptionQuery = z.strictObject({ date: CalendarDate, branchId: z.uuid().optional() });

/** `listExceptions` (CR-059 point 3: `reviewed`). */
export const ExceptionListQuery = z.strictObject({
  date: CalendarDate.optional(),
  from: CalendarDate.optional(),
  to: CalendarDate.optional(),
  kind: ExceptionKindValue.optional(),
  severity: SeverityValue.optional(),
  actorId: z.uuid().optional(),
  branchId: z.uuid().optional(),
  reviewed: BooleanQuery.optional(),
  cursor: z.string().min(1).max(512).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
});

export const ExceptionIdParam = z.uuid();

/** `ExceptionReviewCreate` (CR-059 point 1): the note, as `ReasonRequest.reason`. */
export const ExceptionReviewCreate = z.strictObject({ note: z.string().trim().min(1).max(500) });
