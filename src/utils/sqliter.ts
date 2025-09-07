import { Database } from "bun:sqlite";
import getLogger from "./logger";

const logger = getLogger('sqlite');

type Hql = {
  op: string,
  where: string;
  limit: number;
  attr: string;
  offset: number;
  order: string;
  data?: any;
}

function transformValue(v: boolean | string | number | Date | Object | null) {
  switch (typeof v) {
    case 'boolean':
      return v ? 1 : 0;
    case 'number':
      return v;
    case 'string':
      return `'${v}'`;
    default:
      if (v === null) {
        return "NULL"
      }
      if (v instanceof Date) {
        return `"${v.toJSON()}"`;
      }
      return '""';
  }
}

class Helper<T> {
  db: Database
  table = "";
  hql: Hql = { op: '', where: '', attr: '', limit: 0, offset: 0, order: '' };
  constructor(db: Database, table: string) {
    this.table = table;
    this.db = db;
    return this;
  }
  /**
   * 创建表
   * @param columns 字段和类型
   * @param [opt] 可选参数
   * @returns 
   */
  create(columns: { [key: string]: string }, opt: { NE: boolean } = { NE: true }) {
    const sql = `CREATE TABLE ${opt.NE ? 'IF NOT EXISTS' : ''} ${this.table} (${Object.keys(columns).map(column => column + " " + columns[column]).join(',')})`;
    logger.info(sql, 'create');
    return this.db.query(sql).run();
  }
  /**
   * 删除表
   * @returns 
   */
  drop() {
    const sql = `DROP TABLE ${this.table}`;
    logger.info(sql, 'drop');
    return this.db.query(sql).run();
  }
  /**
   * 插入记录
   * @param data 数据
   * @returns 
   */
  insertOne(data: T) {
    const sql = `INSERT INTO ${this.table}(${Object.keys(data as Object).join(',')}) VALUES(${Object.keys(data as any).map((k: string) => transformValue((data as { [key: string]: string | boolean | Date | number | null })[k]))})`;
    logger.info(sql, 'insert');
    this.db.query(sql).run();
    return data;
  }
  /**
   * 设置查询数量
   * @param n limit
   * @returns this
   */
  limit(n: number) {
    this.hql.limit = n;
    return this;
  }
  /**
   * 偏移量
   * @param n offset
   * @returns this
   */
  skip(n: number) {
    this.hql.offset = n;
    return this;
  }
  /**
   * 设置分页
   * @param o pagination
   * @returns 
   */
  paging(o: { page: number, limit: number }) {
    this.hql.limit = o.limit;
    this.hql.offset = (o.page - 1) * o.limit;
    return this;
  }
  /**
   * 排序
   * @param sort 
   * @returns this
   */
  order(sort: string) {
    this.hql.order = sort;
    return this;
  }
  /**
   * 设置查询字段
   * @param attr 如: "id,name"
   * @returns 
   */
  select(attr: string) {
    this.hql.attr = attr;
    return this;
  }
  /**
   * 查询条件
   * @param where 
   * @returns this
   */
  find(where?: string) {
    this.hql.op = 'find';
    this.hql.where = where || '';
    return this;
  }
  findOne(where?: string) {
    this.hql.op = 'findOne';
    this.hql.where = where || '';
    return this;
  }
  count(where?: string) {
    this.hql.op = 'count';
    this.hql.where = where || '';
    return this;
  }
  /**
   * 更新记录
   * @param where 查询条件
   * @param data 
   * @returns this
   */
  update(where: string, data: Partial<T>) {
    this.hql.op = 'update';
    this.hql.where = where;
    this.hql.data = data;
    return this;
  }
  /**
   * 删除记录
   * @param where 查询条件
   * @returns this
   */
  destroy(where: string) {
    this.hql.op = 'destroy';
    this.hql.where = where;
    return this;
  }
  /**
   * 执行 sql
   * @param sql 原生 sql
   */
  exec(sql: string) {
    return this.db.query(sql).run();
  }
  async then(resolve: (v: any) => null | T | T[]) {
    let sql = '';
    const h = this.hql;
    switch (h.op) {
      case 'find':
        sql = `SELECT ${h.attr || '*'} FROM ${this.table} ${h.where ? 'WHERE ' + h.where : ''} ${h.order ? 'ORDER BY ' + h.order : ''} ${h.limit ? 'LIMIT ' + h.limit : ''}`;
        break;
      case 'findOne':
        sql = `SELECT ${h.attr || '*'} FROM ${this.table} ${h.where ? 'WHERE ' + h.where : ''} ${h.order ? 'ORDER BY ' + h.order : ''}`;
        let v1: any = this.db.query(sql).get();
        logger.info(sql, JSON.stringify(v1), 'findOne')
        return resolve(v1);
      case 'update':
        sql = `UPDATE ${this.table} SET ${Object.keys(h.data).map(k => `${k}=${transformValue(h.data[k])}`).join(',')} ${h.where ? 'WHERE ' + h.where : ''}`;
        break;
      case 'destroy':
        sql = `DELETE FROM ${this.table} ${h.where ? 'WHERE ' + h.where : ''}`;
        const v3 = this.db.query(sql).run();
        logger.info(sql, JSON.stringify(v3), 'delete')
        return resolve(v3);
      case 'count':
        sql = `SELECT COUNT(name) AS count FROM ${this.table} ${h.where ? 'WHERE ' + h.where : ''}`;
        let v2 = await this.db.query(sql).get() as { count: number };
        logger.info(sql, v2.count, 'count')
        return resolve(v2.count);
      default: break;
    }
    try {
      logger.info(sql, h.op);
      const result = h.op === 'find' ? this.db.query(sql).all() : this.db.query(sql).run();
      resolve(result);
    } catch (e) {
      resolve(e);
    }
  }
}

export default function Sqlite<T extends Object>(db: Database, table: string) {
  return new Helper<T>(db, table);
}