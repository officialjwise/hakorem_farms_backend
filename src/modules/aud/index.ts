/**
 * AUD's public door (MODULE_BOUNDARIES, AUD card). From B07 continued it serves the audited settings administration
 * (FR-AUD-007); a module reads a setting through platform `Settings`, never through AUD.
 */
export { AudModule } from './aud.module';
export { SettingsAdmin, type SettingUpdate, type SettingView } from './application/settings-admin';
