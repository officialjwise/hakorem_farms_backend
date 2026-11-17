import { NotFoundError } from '../../../platform/errors/api-error';
import type { BusinessProfiles, ShopProfileValue } from '../../aud';

/**
 * The shop's contact details (CR-028): the trading name, a phone and a WhatsApp number, the farm's address and directions,
 * and opening hours, read through AUD's published `BusinessProfiles.shopProfile`, which hands out those fields and
 * nothing else. Anonymous. 404 while no profile is set: the shop never shows an invented number.
 */
export class ShopProfile {
  constructor(private readonly profiles: BusinessProfiles) {}

  async get(): Promise<ShopProfileValue> {
    const profile = await this.profiles.shopProfile();
    if (profile === null) throw new NotFoundError('no business profile is set');
    return profile;
  }
}
