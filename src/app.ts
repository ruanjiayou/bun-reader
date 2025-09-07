import _ from 'lodash'
import { fileURLToPath } from 'url';
import path from 'path'
import Koa from 'koa'
import Static from 'koa-static'
import Cors from 'koa2-cors'
import { koaBody } from 'koa-body'
import extend from 'utils/extend.js';
import log4js from 'log4js'
import Logger from './utils/logger.js'
import config from 'config.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const app = new Koa();
const logger = Logger('access');

const fn = log4js.connectLogger(logger, {});
app.use(async (ctx, next) => {
  fn(ctx.req, ctx.res, () => { });
  await next();
});

app.use(Cors());

app.use(koaBody({
  multipart: true,
  formidable: {
    uploadDir: config.PATH.ROOT + '/.tmp',
    maxFields: 100,
    maxFieldsSize: 1024 * 1024 * 1024,
    keepExtensions: false,
  }
}));

app.use(Static(path.join(__dirname, '../static')))
app.use(extend)

app.use(async (ctx, next) => {
  console.log(ctx.request.method, ctx.request.path)
  await next()
});

app.on('error', (err, ctx) => {
  console.log(err.message);
})

app.listen(config.PORT, () => {
  console.log(`app listening at: ${config.PORT}`)
})