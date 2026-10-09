/**
 * OneBot 端点探针：给定若干 ws URL，逐个试握手，成功就发一条 get_login_info 看它是不是实现端。
 *
 * 用法：node test/ws-probe.mjs ws://127.0.0.1:3080/ ws://127.0.0.1:3080/onebot/v11/ws ...
 */

import { WebSocket } from 'ws';

const urls = process.argv.slice(2);
const SELF_ID = '30001000';

function probe(url) {
  return new Promise((resolve) => {
    const result = { url, ok: false, error: null, response: null, frames: [] };
    let ws;
    try {
      ws = new WebSocket(url, {
        headers: { 'X-Self-ID': SELF_ID, 'X-Client-Role': 'Universal' },
        handshakeTimeout: 4000,
      });
    } catch (err) {
      result.error = `构造失败: ${err?.message ?? err}`;
      return resolve(result);
    }
    const done = (extra) => {
      Object.assign(result, extra ?? {});
      try {
        ws.close();
      } catch {}
      resolve(result);
    };
    const timer = setTimeout(() => done({ error: result.error ?? '超时未收到任何帧' }), 4000);
    ws.on('open', () => {
      result.ok = true;
      result.response = '101 Switching Protocols';
      ws.send(JSON.stringify({ action: 'get_login_info', params: {}, echo: 'probe' }));
    });
    ws.on('unexpected-response', (_req, res) => {
      clearTimeout(timer);
      done({ error: `HTTP ${res.statusCode} ${res.statusMessage}` });
    });
    ws.on('message', (raw) => {
      result.frames.push(String(raw).slice(0, 300));
      if (result.frames.length >= 2) {
        clearTimeout(timer);
        done();
      }
    });
    ws.on('error', (err) => {
      if (!result.ok) {
        clearTimeout(timer);
        done({ error: String(err?.message ?? err) });
      }
    });
    ws.on('close', () => {
      clearTimeout(timer);
      done();
    });
  });
}

for (const url of urls) {
  const r = await probe(url);
  console.log(`${r.ok ? 'OPEN ' : 'FAIL '} ${r.url}`);
  if (r.error) console.log(`        ${r.error}`);
  if (r.response) console.log(`        ${r.response}`);
  for (const f of r.frames) console.log(`        frame: ${f}`);
}
