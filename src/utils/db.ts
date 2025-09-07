import { Database } from "bun:sqlite";
import Sqlite from "./sqliter";

const db_user = new Database("data/user.db", { create: true });
const db_source = new Database("data/source.db", { create: true });

function hasTable(db: Database, table: string) {
  const row = db.query("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(table);
  return !row ? false : true;
}

if (!hasTable(db_user, 'users')) {
  Sqlite(db_user, 'users').create({
    id: 'CHAR(40) PRIMARY KEY',
    name: 'CHAR(50)',
    avatar: 'CHAR(200)',
    pass: "CHAR(50)",
    salt: "CHAR(16)"
  });

  Sqlite(db_user, 'bookshelf').create({
    id: 'CHAR(40) PRIMARY KEY',
    // 书源id和数量
    bs_id: '',
    numbers: 'INTEGER',
    name: 'CHAR(100)',
    desc: 'CHAR(100)',
    cover: 'CHAR(300)',
  });

}
if (!hasTable(db_source, 'sources')) {
  Sqlite(db_source, 'sources').create({
    id: 'CHAR(40)',
    title: 'CHAR(100)',
    filepath: 'CHAR(300)',
    created_time: 'CHAR(50)',
  });
  Sqlite(db_source, 'books').create({
    bid: 'CHAR(40)',
    sid: 'CHAR(100)',
    filepath: 'CHAR(300)',
    created_time: 'CHAR(50)',
  });
}

export default {
  user: db_user,
  source: db_source,
};