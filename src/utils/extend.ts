// src/middleware/response.ts
import type { Context, Next } from "koa";

type Param = {
  status?: number;
  code?: number;
  message?: string;
}
export default async (ctx: Context, next: Next) => {
  ctx.response.success = function <T = any>(data: T, param: Param = {}) {
    const { status = 200, code = 0, message = '' } = param;
    ctx.status = status;
    ctx.body = {
      code,
      data,
      message,
    };
  };

  ctx.response.failure = function (param: Param = {}) {
    const { status = 200, code = -1, message = '' } = param;
    ctx.status = status;
    ctx.body = {
      code,
      message,
    };
  };

  await next();
};
