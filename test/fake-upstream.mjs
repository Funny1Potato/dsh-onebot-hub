/**
 * 假上游实现端（一次性验证用）：在 127.0.0.1:14515 监听，等 hub 拨号进来后
 * 先握手应答它的 action，再推一条"@我"的群消息事件，把整条链路点亮。
 *
 * 跑法：node test/fake-upstream.mjs [port]
 * 日志：test/fake-upstream.log（同时打屏）
 */

import fs from 'node:fs';
import { WebSocketServer } from 'ws';

const port = Number(process.argv[2] ?? 14515);
const logFile = new URL('./fake-upstream.log', import.meta.url);
fs.writeFileSync(logFile, '');
const log = (...args) => {
  const line = `[${new Date().toISOString()}] ${args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ')}`;
  console.log(line);
  fs.appendFileSync(logFile, `${line}\n`);
};

const SELF_ID = 30001000;
const GROUP_ID = 55555;
let seq = 0;

const wss = new WebSocketServer({ port, host: '127.0.0.1' });
log(`fake upstream listening on ws://127.0.0.1:${port}`);

wss.on('connection', (ws, req) => {
  log('hub connected', {
    url: req.url,
    'x-self-id': req.headers['x-self-id'],
    'x-client-role': req.headers['x-client-role'],
  });

  ws.on('message', (raw) => {
    let frame = null;
    try {
      frame = JSON.parse(String(raw));
    } catch {
      log('unparsable frame', String(raw).slice(0, 200));
      return;
    }
    if (frame.action) return; // 上游实现端不会往这个方向发 action
    // hub 发来的 action 请求（hub 自己发言 / 取信息）
    const { action, params = {}, echo } = frame;
    log('action from hub', { action, params });
    let data = {};
    if (action === 'send_msg') data = { message_id: 700000000 + (seq += 1) };
    else if (action === 'get_login_info') data = { user_id: 10001, nickname: 'fake-impl-bot' };
    else if (action === 'get_status') data = { online: true, good: true };
    ws.send(JSON.stringify({ status: 'ok', retcode: 0, data, echo: echo ?? null }));
  });

  ws.on('close', () => log('hub disconnected'));

  setTimeout(() => {
    const event = {
      time: Math.floor(Date.now() / 1000),
      self_id: SELF_ID,
      post_type: 'message',
      message_type: 'group',
      sub_type: 'normal',
      message_id: 700000001,
      group_id: GROUP_ID,
      user_id: 10001,
      raw_message: `[CQ:at,qq=${SELF_ID}] 你好 hub，在吗？`,
      font: 0,
      sender: { user_id: 10001, nickname: '小明', card: '', role: 'member' },
      anonymous: null,
      message: [
        { type: 'at', data: { qq: String(SELF_ID) } },
        { type: 'text', data: { text: ' 你好 hub，在吗？' } },
      ],
    };
    log('pushing event', { message_id: event.message_id, raw_message: event.raw_message });
    ws.send(JSON.stringify(event));
  }, 1200);
});

process.on('SIGINT', () => {
  wss.close();
  process.exit(0);
});
