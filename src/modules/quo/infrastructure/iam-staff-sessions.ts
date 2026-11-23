import type { ModuleRef } from '@nestjs/core';
import { AuthenticationService } from '../../iam';
import type { StaffSessionLookup } from '../application/quotes';

/**
 * QUO's StaffSessionLookup through IAM's public AuthenticationService (abuse case 40): the staff session behind an
 * access cookie, if it is live. Resolved from the application's container when first asked, since IAM's Nest module
 * does not export the service to other modules (IAM is lane A's; B10 continued 4 changes nothing in it).
 */
export class IamStaffSessions implements StaffSessionLookup {
  private service: AuthenticationService | undefined;

  constructor(private readonly modules: ModuleRef) {}

  async staffOf(accessToken: string): Promise<{ principalId: string; sessionId: string } | null> {
    const service: AuthenticationService = this.service ?? this.modules.get(AuthenticationService, { strict: false });
    this.service = service;
    const authenticated = await service.authenticate('STAFF', accessToken);
    if (authenticated === null || authenticated.actor.sessionId === null) return null;
    return { principalId: authenticated.actor.principalId, sessionId: authenticated.actor.sessionId };
  }
}
