/** A reminder channel, in the customer's order of preference within a level (FR-WHL-011). */
export type DunningChannel = 'SMS' | 'EMAIL' | 'WHATSAPP';

/** One reminder level of the dunning policy (`whl.dunning_policy`). */
export interface DunningLevelRule {
  readonly level: number;
  readonly daysOverdue: number;
  readonly channels: readonly DunningChannel[];
  readonly templateCode: string;
}

export type DunningRule = 'LEVELS_NOT_CONSECUTIVE' | 'DAYS_NOT_INCREASING' | 'CHANNEL_REPEATED' | 'TEMPLATE_NOT_A_REMINDER';

/**
 * The reminder templates a level may pick (B11 continued 13, the owner 2026-11-23): the codes NTF lists under
 * `listNotificationTemplates?category=REMINDER` and has triggers for, never a code typed in. Held by the database too
 * (`ck_dunning_policy_template`).
 */
export const REMINDER_TEMPLATES: readonly string[] = ['PAYMENT_REMINDER_1', 'PAYMENT_REMINDER_2', 'PAYMENT_REMINDER_3'];

/**
 * The level an invoice is due on a day (FR-WHL-011): the highest level whose days overdue it has reached, provided no
 * level as high or higher has reached it already. Each level reaches an invoice at most once (the database holds it,
 * `uq_dunning_notice_level`), and a level passed while the job did not run is never sent late below a higher one.
 */
export function levelDue(daysPastDue: number, levels: readonly DunningLevelRule[], sentLevels: readonly number[]): DunningLevelRule | null {
  const reached = [...levels].filter((l) => l.daysOverdue <= daysPastDue).sort((a, b) => b.level - a.level)[0];
  if (reached === undefined) return null;
  return sentLevels.some((s) => s >= reached.level) ? null : reached;
}

/** A replacement set of levels: numbered 1, 2, 3 in turn, each firing later than the one before, no channel twice. */
export function judgeLevels(levels: readonly DunningLevelRule[]): { readonly field: string; readonly rule: DunningRule }[] {
  const broken: { field: string; rule: DunningRule }[] = [];
  const ordered = levels.map((l, index) => ({ l, index })).sort((a, b) => a.l.level - b.l.level);
  ordered.forEach(({ l, index }, position) => {
    if (l.level !== position + 1) broken.push({ field: `/levels/${String(index)}/level`, rule: 'LEVELS_NOT_CONSECUTIVE' });
    else if (position > 0 && l.daysOverdue <= ordered[position - 1]!.l.daysOverdue) broken.push({ field: `/levels/${String(index)}/daysOverdue`, rule: 'DAYS_NOT_INCREASING' });
    if (new Set(l.channels).size !== l.channels.length) broken.push({ field: `/levels/${String(index)}/channels`, rule: 'CHANNEL_REPEATED' });
    if (!REMINDER_TEMPLATES.includes(l.templateCode)) broken.push({ field: `/levels/${String(index)}/templateCode`, rule: 'TEMPLATE_NOT_A_REMINDER' });
  });
  return broken;
}

/** The levels lowest first. */
export function byLevel(levels: readonly DunningLevelRule[]): DunningLevelRule[] {
  return [...levels].sort((a, b) => a.level - b.level);
}
