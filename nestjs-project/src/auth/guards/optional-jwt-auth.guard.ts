import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { BEARER_PREFIX } from '../auth.constants';
import { JwtPayload } from '../auth.types';

/**
 * For routes that are public but behave differently for the owner.
 *
 * Never rejects: a missing or invalid token simply leaves `request.user`
 * undefined and the handler treats the caller as anonymous. Routes using this
 * guard must still be marked `@Public()` so the global `JwtAuthGuard` lets them
 * through.
 */
@Injectable()
export class OptionalJwtAuthGuard implements CanActivate {
  constructor(private readonly jwtService: JwtService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context
      .switchToHttp()
      .getRequest<{ headers: Record<string, string>; user?: JwtPayload }>();
    const authHeader = request.headers?.authorization;

    if (!authHeader?.startsWith(BEARER_PREFIX)) return true;

    try {
      request.user = await this.jwtService.verifyAsync<JwtPayload>(
        authHeader.slice(BEARER_PREFIX.length),
      );
    } catch {
      // Anonymous access is legitimate here — a bad token is not an error.
    }

    return true;
  }
}
