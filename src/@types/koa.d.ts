import Koa, { ParameterizedContext, BaseContext, ExtendableContext } from 'koa'
import Application from 'koa';

declare module 'koa' {
  export interface ExtendableContext {
    config: {
      [key: string]: any;
    };
  };

  interface DefaultContext {
    config: {
      [key: string]: any;
    };
  }

  interface BaseRequest {
    paginate: (fn?: (hql: OPT) => void) => OPT;
  }

  interface BaseResponse {
    success: (params?: { items?: Object[], item?: Object, count?: number } & any, extra?: { status?: number, code?: number, message?: string }) => void;
    failure: (params?: { code?: number, message?: string, status?: number }) => void;
  }

}
