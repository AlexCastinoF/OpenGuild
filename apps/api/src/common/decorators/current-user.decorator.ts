import { createParamDecorator, ExecutionContext } from '@nestjs/common';

export type AuthPayload = {
  id: number;
  username: string;
  role: string;
};

export const CurrentUser = createParamDecorator((_data: unknown, ctx: ExecutionContext): AuthPayload => {
  const req = ctx.switchToHttp().getRequest();
  return req.user;
});
