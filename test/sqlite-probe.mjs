// 探测 DSH 插件可用的本地检索后端：node:sqlite 是否可用、FTS5 与 json1 是否编译进来。
// 用途：决定 §21.9 / §24 的记忆落盘与"聊天记录全文检索"实现路线。
import { DatabaseSync } from 'node:sqlite';

const out = { node: process.version };

try {
  const db = new DatabaseSync(':memory:');
  out.sqliteVersion = db.prepare('select sqlite_version() as v').get().v;

  try {
    db.exec('create virtual table t using fts5(x, tokenize = "unicode61")');
    out.fts5 = 'AVAILABLE';
    db.exec("insert into t(x) values ('今天天气不错')");
    out.fts5Query = db.prepare('select x from t where t match ?').all('天气');
  } catch (err) {
    out.fts5 = `MISSING: ${err.message}`;
  }

  try {
    out.json1 = db.prepare(`select json_extract('{"a":1}', '$.a') as a`).get().a;
  } catch (err) {
    out.json1 = `MISSING: ${err.message}`;
  }

  // 中文分词：unicode61 不切中文词，验证 bigram 兜底思路是否可行
  try {
    db.exec('create virtual table t2 using fts5(x, tokenize = "trigram")');
    db.exec("insert into t2(x) values ('用户发了一张梗图')");
    out.trigram = db.prepare('select count(*) as c from t2 where t2 match ?').get('梗图').c > 0;
  } catch (err) {
    out.trigram = `MISSING: ${err.message}`;
  }

  console.log(JSON.stringify(out, null, 2));
} catch (err) {
  console.log(JSON.stringify({ node: process.version, sqlite: `NOT AVAILABLE: ${err.message}` }, null, 2));
}
