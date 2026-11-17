/**
 * AUD's public door (MODULE_BOUNDARIES, AUD card). From B07 continued it serves the audited settings administration
 * (FR-AUD-007); a module reads a setting through platform `Settings`, never through AUD. From B09x continued it serves
 * the business profile (FR-AUD-008): `BusinessProfiles.shopProfile` is the shop's contact details and nothing else (CR-028),
 * and `update` is for the seed alone besides AUD's own controller.
 */
export { AudModule } from './aud.module';
export { SettingsAdmin, type SettingUpdate, type SettingView } from './application/settings-admin';
export { BusinessProfiles, type BusinessProfileUpdate, type BusinessProfileView } from './application/business-profiles';
export { WEEKDAYS, type OpeningInterval, type ShopProfileValue, type Weekday } from './domain/business-profile';
