// 探测二：中文检索的三条候选路线在 node:sqlite(FTS5) 上的真实表现。
// 路线 A：fts5 unicode61 + 写入时人工切成 bigram（空格分隔）
// 路线 B：fts5 trigram 分词器（查询需 >=3 字符）
// 路线 C：fts5 unicode61 不做任何处理（预期：整段中文成为一个 token，子串查不到）
import { DatabaseSync } from 'node:sqlite';

const bigrams = (s) => {
  const chars = [...s].filter((c) => /[\u4e00-\u9fff]/.test(c) || /[A-Za-z0-9]/.test(c));
  const out = [];
  for (let i = 0; i < chars.length - 1; i += 1) out.push(chars[i] + chars[i + 1]);
  return out.length ? out.join(' ') : s;
};

const db = new DatabaseSync(':memory:');
const out = {};

const lines = [
  '今天天气不错啊',
  '用户发了一张梗图',
  '老张说这个bug我来修',
  '今天下午三点开会',
];

db.exec('create virtual table a using fts5(body)');
const insA = db.prepare('insert into a(body) values (?)');
for (const l of lines) insA.run(bigrams(l));

db.exec('create virtual table b using fts5(body, tokenize = "trigram")');
const insB = db.prepare('insert into b(body) values (?)');
for (const l of lines) insB.run(l);

db.exec('create virtual table c using fts5(body)');
const insC = db.prepare('insert into c(body) values (?)');
for (const l of lines) insC.run(l);

const q = (table, expr) => {
  try {
    return db.prepare(`select body from ${table} where ${table} match ?`).all(expr).length;
  } catch (err) {
    return `ERR: ${err.message}`;
  }
};

out.A_bigram_今天 = q('a', bigrams('今天'));          // 期望 2（两条含"今天"）
out.A_bigram_梗图 = q('a', bigrams('梗图'));          // 期望 1
out.A_bigram_天气不错 = q('a', bigrams('天气不错'));  // 期望 1
out.B_trigram_梗图_2字 = q('b', '梗图');               // 期望 0（trigram 要 >=3）
out.B_trigram_今天天 = q('b', '今天天');               // 期望 1
out.C_unicode61_今天 = q('c', '今天');                 // 期望 0（整段是一个 token）
out.C_unicode61_整句 = q('c', '今天天气不错啊');        // 期望 1

// 路线 A 的短语查询是否仍能工作（bigram 序列）
out.A_phrase = q('a', `"${bigrams('天气不错')}"`);

console.log(JSON.stringify(out, null, 2));
