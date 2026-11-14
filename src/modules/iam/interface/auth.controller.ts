import { Body, Controller, Get, HttpCode, Inject, Post, Req, Res } from '@nestjs/common';
import type { Clock } from '@hakorem/kernel';
import type { Response } from 'express';
import type { Realm } from '../../../platform/context/request-context';
import { UnauthenticatedError } from '../../../platform/errors/api-error';
import { Operation } from '../../../platform/http/operation';
import { zodPipe } from '../../../platform/http/validation';
import { CLOCK } from '../../../platform/platform.module';
import { AuthenticationService, type AccountCaller, type TotpEnrolmentView } from '../application/authentication.service';
import type { IssuedSession, LoginOutcome, SessionInfoView } from '../application/session-view';
import { clearSessionCookies, readCookies, REALMS, refreshCookieName, setSessionCookies } from './cookies';
import { requestedRealm, type GuardedRequest } from './authentication.guard';
import { LoginRequest, PasswordChangeRequest, StepUpRequest, TotpCodeRequest, TotpEnrolmentStart, TotpVerifyRequest } from './schemas';
import type { z } from 'zod';

/** The contract's `LoginResult`. */
interface LoginResult {
  readonly status: 'AUTHENTICATED' | 'TOTP_REQUIRED' | 'TOTP_ENROLMENT_REQUIRED' | 'PASSWORD_CHANGE_REQUIRED';
  readonly challengeToken: string | null;
  readonly session: SessionInfoView | null;
}

function callerOf(req: GuardedRequest, challengeToken: string | undefined): AccountCaller {
  if (req.hkAuth !== undefined) {
    return { kind: 'SESSION', actor: req.hkAuth.actor };
  }
  if (challengeToken !== undefined) {
    return { kind: 'CHALLENGE', token: challengeToken };
  }
  throw new UnauthenticatedError('neither a session nor a login challenge');
}

const PUBLIC_AUTH = { access: 'PUBLIC', realms: [], permission: null, idempotent: false, csrf: false, rateLimit: 'auth' } as const;
const OWN_ACCOUNT = { access: 'SESSION', realms: REALMS, permission: null, idempotent: false, csrf: true, rateLimit: 'auth' } as const;

/**
 * Login, the steps between password and session, refresh, logout and the current session (docs/API.md section 3).
 * None takes an Idempotency-Key (ADR-0014); every one is in the login rate-limit group, which fails closed.
 */
@Controller('auth')
export class AuthController {
  constructor(
    @Inject(AuthenticationService) private readonly authentication: AuthenticationService,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  @Post('staff/login')
  @HttpCode(200)
  @Operation({ operationId: 'loginStaff', ...PUBLIC_AUTH })
  loginStaff(@Body(zodPipe(LoginRequest)) body: z.infer<typeof LoginRequest>, @Res({ passthrough: true }) res: Response): Promise<LoginResult> {
    return this.login('STAFF', body, res);
  }

  @Post('customer/login')
  @HttpCode(200)
  @Operation({ operationId: 'loginCustomer', ...PUBLIC_AUTH })
  loginCustomer(@Body(zodPipe(LoginRequest)) body: z.infer<typeof LoginRequest>, @Res({ passthrough: true }) res: Response): Promise<LoginResult> {
    return this.login('CUSTOMER', body, res);
  }

  @Post('investor/login')
  @HttpCode(200)
  @Operation({ operationId: 'loginInvestor', ...PUBLIC_AUTH })
  loginInvestor(@Body(zodPipe(LoginRequest)) body: z.infer<typeof LoginRequest>, @Res({ passthrough: true }) res: Response): Promise<LoginResult> {
    return this.login('INVESTOR', body, res);
  }

  @Post('totp/verify')
  @HttpCode(200)
  @Operation({ operationId: 'verifyTotp', ...PUBLIC_AUTH })
  async verifyTotp(@Body(zodPipe(TotpVerifyRequest)) body: z.infer<typeof TotpVerifyRequest>, @Res({ passthrough: true }) res: Response): Promise<LoginResult> {
    const issued = await this.authentication.verifyTotp(body.challengeToken, body.code);
    return this.authenticated(issued, res);
  }

  @Post('refresh')
  @HttpCode(200)
  @Operation({ operationId: 'refreshSession', ...PUBLIC_AUTH, originRequired: true })
  async refreshSession(@Req() req: GuardedRequest, @Res({ passthrough: true }) res: Response): Promise<SessionInfoView> {
    const cookies = readCookies(req);
    const present = REALMS.filter((realm) => cookies.has(refreshCookieName(realm)));
    const realm = requestedRealm(req, REALMS) ?? (present.length === 1 ? present[0] : undefined);
    if (realm === undefined) {
      throw new UnauthenticatedError(present.length === 0 ? 'no refresh cookie' : 'refresh cookies of several realms and no realm named');
    }
    try {
      const issued = await this.authentication.refresh(realm, cookies.get(refreshCookieName(realm)));
      setSessionCookies(res, issued, this.clock.now());
      return issued.info;
    } catch (error) {
      clearSessionCookies(res, realm);
      throw error;
    }
  }

  @Post('logout')
  @HttpCode(204)
  @Operation({ operationId: 'logout', ...OWN_ACCOUNT, allowedWithTemporaryPassword: true })
  async logout(@Req() req: GuardedRequest, @Res({ passthrough: true }) res: Response): Promise<void> {
    const auth = req.hkAuth!;
    await this.authentication.logout(auth.actor);
    clearSessionCookies(res, auth.session.realm);
  }

  @Get('session')
  @Operation({ operationId: 'getCurrentSession', ...OWN_ACCOUNT, csrf: false, rateLimit: 'console', allowedWithTemporaryPassword: true })
  getCurrentSession(@Req() req: GuardedRequest): Promise<SessionInfoView> {
    return this.authentication.currentSession(req.hkAuth!);
  }

  @Post('password/change')
  @HttpCode(204)
  @Operation({ operationId: 'changePassword', ...OWN_ACCOUNT, allowedWithTemporaryPassword: true, acceptsLoginChallenge: true })
  async changePassword(@Req() req: GuardedRequest, @Body(zodPipe(PasswordChangeRequest)) body: z.infer<typeof PasswordChangeRequest>): Promise<void> {
    await this.authentication.changePassword(callerOf(req, body.challengeToken), body.currentPassword, body.newPassword);
  }

  @Post('totp/enrol')
  @HttpCode(200)
  @Operation({ operationId: 'startTotpEnrolment', ...OWN_ACCOUNT, acceptsLoginChallenge: true })
  startTotpEnrolment(
    @Req() req: GuardedRequest,
    @Body(zodPipe(TotpEnrolmentStart)) body: z.infer<typeof TotpEnrolmentStart>,
  ): Promise<TotpEnrolmentView> {
    return this.authentication.startTotpEnrolment(callerOf(req, body?.challengeToken));
  }

  @Post('totp/confirm')
  @HttpCode(200)
  @Operation({ operationId: 'confirmTotpEnrolment', ...OWN_ACCOUNT, acceptsLoginChallenge: true })
  async confirmTotpEnrolment(
    @Req() req: GuardedRequest,
    @Body(zodPipe(TotpCodeRequest)) body: z.infer<typeof TotpCodeRequest>,
    @Res({ passthrough: true }) res: Response,
  ): Promise<{ recoveryCodes: string[] }> {
    const confirmed = await this.authentication.confirmTotpEnrolment(callerOf(req, body.challengeToken), body.code);
    if (confirmed.issued !== null) {
      // Enrolment during login completes the login: the cookies are set and the client reads GET /auth/session.
      setSessionCookies(res, confirmed.issued, this.clock.now());
    }
    return { recoveryCodes: confirmed.recoveryCodes };
  }

  @Post('step-up')
  @HttpCode(200)
  @Operation({ operationId: 'stepUp', ...OWN_ACCOUNT })
  stepUp(@Req() req: GuardedRequest, @Body(zodPipe(StepUpRequest)) body: z.infer<typeof StepUpRequest>): Promise<SessionInfoView> {
    return this.authentication.stepUp(req.hkAuth!, body.code);
  }

  private async login(realm: Realm, body: z.infer<typeof LoginRequest>, res: Response): Promise<LoginResult> {
    const outcome: LoginOutcome = await this.authentication.login(realm, body);
    if (outcome.kind === 'CHALLENGE') {
      return { status: outcome.status, challengeToken: outcome.challengeToken, session: null };
    }
    return this.authenticated(outcome.issued, res);
  }

  private authenticated(issued: IssuedSession, res: Response): LoginResult {
    setSessionCookies(res, issued, this.clock.now());
    return { status: 'AUTHENTICATED', challengeToken: null, session: issued.info };
  }
}
