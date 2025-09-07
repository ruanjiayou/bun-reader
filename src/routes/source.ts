import Router from 'koa-router'
import Sqlite from '../utils/sqliter';
import dbs from '../utils/db';
import { v7 } from 'uuid';

const router = new Router();

router.get('/', async ({ request, response }) => {
  const sqliter = Sqlite(dbs.source, 'sources');
  const docs = await sqliter.find().order('nth ASC');
  sqliter.db.close(false);
  response.success(docs);
})

router.post('/', async ({ request, response }) => {
  const sqliter = Sqlite(dbs.source, 'apps');
  const data = request.body;
  data.id = v7();
  const doc = sqliter.insertOne(data);
  sqliter.db.close(false);
  response.success(doc);
});

router.put('/:id', async ({ request, params, response }) => {
  const sqliter = Sqlite(dbs.source, 'apps');
  await sqliter.update(`id="${params.id}"`, request.body);
  sqliter.db.close(false);
  response.success();
});

router.put('/', async ({ request, response }) => {
  const sqliter = Sqlite<{ nth: number }>(dbs.source, 'apps');
  const batch = request.body;
  for (let i = 0; i < batch.length; i++) {
    await sqliter.update(`id="${batch[i].id}"`, { nth: batch[i].nth });
  }
  sqliter.db.close(false);
  response.success();
})

router.delete('/:id', async ({ request, params, response }) => {
  const sqliter = Sqlite(dbs.source, 'apps');
  await sqliter.destroy(`id="${params.id}"`);
  sqliter.db.close(false);
  response.success();
});



export default router;