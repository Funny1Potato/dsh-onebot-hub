/**
 * 装载检查：用**真** `lib/index.js` 跑一遍 DSH 插件的完整装载路径。
 *
 * 目的：`smoke-core` / `m15-e2e` / `hub-e2e` 都是绕过 `lib/index.js` 直接 import 内部模块，
 * 所以"插件能不能被 DSH 装起来"这条路径此前从未被执行过。这里用假 ctx 扮演宿主：
 *  - 真 schemastery `Config`、真 `defineTool`、真 `apply()`
 *  - 假 `webServer` / `tools` / `systemPrompt` / `agents` / `agentDefaultModel`
 * 不连任何网络（upstreamUrl 为空、downstreamTargets 为空），只验证接线与注册面。
 *
 * 跑法：node test/load-check.mjs
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Config, apply, auditClientModules, buildHubGuidance, claimImageQuota, describeCodeScopes, inject, makeReplyTool, name, normalizeTargets, parseCodeRoots, parseCodeScopes, parseListenTarget, parseModelRef, resolveConfig } from '../lib/index.js';
import { ReplyBuffer } from '../lib/reply.js';
import { DEFAULT_GUIDANCE } from '../lib/mind.js';
import { CLIENT_PROBE_PATH, clientReportStatus, installClientProbe, noteClientReport } from '../lib/client-probe.js';
import { MODEL_LIST_PATH, installModelListRoute } from '../lib/llm-models.js';
import { describePolicy, resolvePolicy } from '../lib/router.js';
import { COMMAND_SPECS } from '../lib/chat-commands.js';
import { filterForScope, resolveIsolation, setGroupMembershipProvider } from '../lib/memory/isolation.js';
import { inferWriteVisibility } from '../lib/memory/writer.js';

const here = path.dirname(fileURLToPath(import.meta.url));

/**
 * 从源码里抠出一个**严格 JSON** 的对象字面量（`const X = { … }`）：括号配对、跳过字符串里的括号。
 * 浏览器半侧的表只能这么读——它是经典脚本，不能 import。
 */
const extractJsonObject = (source, marker) => {
  const at = source.indexOf(marker);
  assert.ok(at >= 0, `源码里找不到 ${marker}`);
  const brace = source.indexOf('{', at);
  assert.ok(brace >= 0, `${marker} 后面没有对象字面量`);
  let depth = 0;
  let end = -1;
  let inString = false;
  let escaped = false;
  for (let i = brace; i < source.length; i += 1) {
    const ch = source[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') { inString = true; continue; }
    if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) { end = i + 1; break; }
    }
  }
  assert.ok(end > brace, `${marker} 的对象字面量没有闭合`);
  return JSON.parse(source.slice(brace, end));
};

const results = [];
const notes = [];
const check = (label, fn) => {
  try {
    fn();
    results.push({ label, ok: true });
  } catch (err) {
    results.push({ label, ok: false, error: String(err?.message ?? err) });
  }
};
const note = (label, text) => notes.push({ label, text });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const checkAsync = async (label, fn) => {
  try {
    await fn();
    results.push({ label, ok: true });
  } catch (err) {
    results.push({ label, ok: false, error: String(err?.message ?? err) });
    if (process.env.LC_STACK && err?.stack) console.error(err.stack);
  }
};

/**
 * 假 agent 作用域上下文：`installModelSelection` 的真实要求只有真 DSH 能证明。
 * 传 `recorded` 时额外暴露 `on`/`effect`——用来验"会话作用域那条 session/event 订阅"。
 * `opts.failFirstRegister`（m11162）：让**第一次** register 故意抛错——setup 里那一次就是会话版
 * `onebot_reply`，用来复现"会话版挂不上"的场景（此时 `skipNames` 为空、直发版顶上）。
 */
function fakeAgentCtx(recorded, opts = {}) {
  let firstRegisterFailed = false;
  const agentCtx = {
    systemPrompt: {
      context: (spec) => {
        recorded?.contexts?.push(spec);
        return () => {};
      },
      // m10863：枢纽指导段从 profile 全局层搬进了会话装配（`agentCtx.systemPrompt.section`）。
      section: (spec) => {
        recorded?.agentSections?.push(spec);
        return () => {};
      },
    },
    tools: {
      // m10863：28 个 onebot_* 工具注册在会话装配（setup）的 **agent 作用域**里，定义收进
      // recorded.agentTools。
      // m11162：真宿主在**同一个作用域**里遇到重名会**抛错**
      // （`@deepseek-ai/dsh-tools` `lib/types/index.js:179-180`
      // `tool "${name}" is already registered in this scope`），而且抛错会**中断同一批剩下的注册**——
      // 假 ctx 必须一样凶，否则"一个重名把后面 22 个工具全带走"这类真机事故测不出来。
      register: (def) => {
        if (opts.failFirstRegister && !firstRegisterFailed) {
          firstRegisterFailed = true;
          throw new Error('probe：故意让第一次注册（会话版回复工具）失败');
        }
        if (recorded && def?.name) {
          const list = (recorded.agentTools ??= []);
          if (list.some((t) => t.name === def.name)) {
            throw new Error(`tool "${def.name}" is already registered in this scope`);
          }
          list.push(def);
        }
        return () => {};
      },
      // 全局工具视图（globalToolNames 读它）：用例往 recorded.agentToolSchemas 里塞假清单。
      schemas: () => recorded?.agentToolSchemas ?? [],
      // restrict(filter) 的调用记录（applyToolDeny 走它）——遮罩名单/生图工具放行的断言看这里。
      restrict: (filter = {}) => {
        recorded?.agentRestricts?.push(filter ?? null);
        return () => {};
      },
    },
  };
  if (recorded) {
    agentCtx.on = (name, handler) => {
      recorded.agentEvents.push({ name, handler });
      return () => {};
    };
    agentCtx.effect = (fn) => {
      recorded.effects.push({ label: 'agent-scope', dispose: fn() });
      return () => {};
    };
  }
  return agentCtx;
}

function makeCtx(extraServices = {}) {
  const recorded = {
    effects: [],
    /** 全局层注册的工具（m10863 后枢纽**不该**再往这里挂东西——回归断言钉住）。 */
    globalTools: [],
    upgrades: [],
    routes: [],
    sections: [],
    injects: [],
    created: [],
    resumed: [],
    onEvents: [],
    agentEvents: [],
    presetMounts: [],
    /** hub 注册过的预设定义（fake register 收到的 definition，m05750 slim 清单断言用）。 */
    presetRegisters: [],
    /** 会话级 `systemPrompt.context(...)` 的登记（live 上下文走这里）。 */
    contexts: [],
    /** 会话改名的调用记录（`sessions.rename`）。 */
    titles: [],
    /** 归档旧会话的调用记录（`workspaceRegistry.archiveSession`）。 */
    archives: [],
    /** 挂工作区的调用记录（`workspace.attachSession`，issue #1）。 */
    attaches: [],
    /** 假工作区注册表里"已登记的工作区"（用例自己塞，字段 path / id / attachSession）。 */
    workspaces: [],
    /** 喂给 agent 的用户消息（`followup` 的实参）——批量渲染/补描的断言都看这里。 */
    followups: [],
    /** 假 agent 作用域的全局工具清单（用例自己塞）与 restrict(filter) 的调用记录。 */
    agentToolSchemas: null,
    agentRestricts: [],
    /** m10863：会话装配（setup）里注册的工具定义与指导段（用例经 probeHub 取）。 */
    agentTools: [],
    agentSections: [],
  };
  // 假 `agentPresets`：宿主有一条不变量——没加入任何预设的 agent 一旦去喊模型，
  // `system-prompt/assemble` 直接判失败。这里只验证"我们确实 resolve 了默认预设、并在
  // setup 回调里 mount 了它"；真 mount 的效果只能由真 DSH 证明。
  // resolve(id)：带 id 按名字解析（预设切换用例看 recorded.created[].meta.agentPreset），
  // 未知名字抛 agent-preset/not-found（真服务的语义：未知抛错，hub 要退回默认预设）。
  // register(definition)：m04972 定稿——hub 装配时注册内置精简预设 onebot-hub-slim；
  // 假件照真服务的语义把它收进清单、返回注销函数（重复 id 会 throw Duplicate）。
  const fakePresets = {
    definitions: new Map([['standard', { id: 'standard', plugins: [] }]]),
    resolve: async (id) => {
      const wanted = String(id ?? '').trim();
      if (!wanted) return { id: 'standard' };
      const def = fakePresets.definitions.get(wanted);
      if (def) return { id: wanted };
      const err = new Error(`agent-preset/not-found: ${wanted}`);
      err.meta = { available: [...fakePresets.definitions.keys()] };
      throw err;
    },
    register: async (definition) => {
      const id = String(definition?.id ?? '');
      if (!id) throw new Error('agent-preset: id required');
      if (fakePresets.definitions.has(id)) throw new Error(`Duplicate agent preset: ${id}`);
      fakePresets.definitions.set(id, { ...definition });
      recorded.presetRegisters.push({ ...definition, plugins: definition?.plugins?.map((r) => ({ ...r })) ?? definition?.plugins });
      return async () => fakePresets.definitions.delete(id);
    },
    mount: async (agentCtx, id) => {
      recorded.presetMounts.push({ id, agentCtx });
      return { id: id ?? 'standard' };
    },
  };
  /** 假会话服务：`rename(sessionId, title)`（用户要求"会话按群名+时间命个名"）。 */
  const fakeSessions = {
    rename: async (sessionId, title) => {
      recorded.titles.push({ sessionId, title });
      return { ok: true, value: { title, seq: 1 } };
    },
  };
  /** 假工作区注册表：`archiveSession(sessionId, {stopActivity})`（"旧的会话直接归档即可"）。 */
  const fakeWorkspace = {
    archiveSession: async (sessionId, options = {}) => {
      recorded.archives.push({ sessionId, stopActivity: options.stopActivity === true });
      return { ok: true, value: { archivedSessionIds: [sessionId] } };
    },
    // issue #1：hub 会按路径在已登记的工作区里找目标，找到就 attachSession。
    list: async () => recorded.workspaces,
  };
  /** 用例自己塞进来的宿主服务（`permissionPresets` 之类）；没给就当宿主没这个服务。 */
  const extras = { ...extraServices };
  const sctxBase = {
    effect(fn, label) {
      recorded.effects.push({ label: label ?? 'scoped', dispose: fn() });
      return () => {};
    },
    get: (name) => {
      if (name === 'agentPresets') return fakePresets;
      if (name === 'sessions') return extras.sessions ?? fakeSessions;
      if (name === 'workspaceRegistry') return fakeWorkspace;
      return extras[name] ?? undefined;
    },
  };
  const ctx = {
    effect(fn, label) {
      recorded.effects.push({ label, dispose: fn() });
      return () => {};
    },
    tools: {
      register(def) {
        recorded.globalTools.push(def);
        return () => {};
      },
      // plugin 生图引擎用例：给 ctx 一份全局工具清单（extras.toolsSchemas）。
      ...(extraServices.toolsSchemas ? { schemas: () => extraServices.toolsSchemas } : {}),
    },
    webServer: {
      registerUpgrade(route) {
        recorded.upgrades.push(route);
        return () => {};
      },
      register(route) {
        recorded.routes.push(route);
        return () => {};
      },
    },
    get: (name) => extras[name] ?? undefined,
    on(name, handler) {
      recorded.onEvents.push({ name, handler });
      return () => {};
    },
    inject(names, cb) {
      recorded.injects.push(names);
      if (names.includes('systemPrompt')) {
        cb({
          ...sctxBase,
          systemPrompt: {
            section(section) {
              hubSections().push(section);
              return () => {};
            },
          },
        });
        return;
      }
      if (names.includes('agents')) {
        // 真宿主返回的是句柄 `{ agent, dispose }`，会话对象在 handle.agent。
        const handle = (sessionId) => ({
          id: sessionId,
          agent: {
            id: sessionId,
            followup(msg) {
              // 无 createUserMessage 的假宿主收到的是 `{role:'user', content:[…]}`，首段是文本。
              recorded.followups.push(msg);
            },
            whenIdle: async () => true,
          },
          dispose() {},
        });
        cb({
          ...sctxBase,
          agents: {
            create(input) {
              recorded.created.push(input);
              input.setup?.(fakeAgentCtx(recorded));
              return handle(input.sessionId);
            },
            resume(input) {
              recorded.resumed.push(input);
              if (recorded.resumeError) return Promise.reject(new Error(recorded.resumeError));
              input.setup?.(fakeAgentCtx(recorded));
              return handle(input.resumeSessionId);
            },
          },
          agentDefaultModel: {
            currentSelection: () => ({ provider: 'qwen-tp', model: 'deepseek-v4.1-flash' }),
          },
        });
        return;
      }
      cb(ctx);
    },
  };
  return { ctx, recorded };
}

// 「源码范围」这套测试要有一个**真的存在的目录**才能断言 exists/kind。写死某台机器上的
// 路径（曾经写的是本机 LLBot 安装目录）在本地一直绿、在 CI 上必红——所以改用仓库自己：
// 任何 checkout 里它都在，Windows 上斜杠也统一成 `/`（与下面 alt 实例的写法一致）。
const repoDir = process.cwd().replace(/\\/g, '/');

const { ctx, recorded } = makeCtx();
const hub = apply(ctx, {
  upstreamUrl: '',
  upstreamSelfId: '30001000',
  downstreamTargets: '[]',
  agent: { mode: 'assist', batchMs: 500 },
  // 下游源码范围：多条（m14477）。位置**不进 prompt**，只由 onebot_code_scopes 回答。
  code: { scopes: `[{"name":"下游A","path":"${repoDir}"},{"name":"下游B","path":"D:/不存在的路径/nope"}]` },
  memory: { isolation: { level: 'scoped' } },
  // 测试不该往用户家里写东西：`persist:false` = 存储层整体关闭（不建目录、不落盘）。
  persist: false,
});
await sleep(60); // 等 agent 通道那次动态 import 落地

/**
 * **工具/指导段探针（m10863）**：28 个 onebot_* 工具与枢纽指导段都从 profile 全局层搬进了
 * 会话装配 `setup(agentCtx)`（agent 作用域）——apply 阶段不再往全局层注册任何东西。
 * 需要"工具定义清单 / 指导段正文"的用例走这个：用一个假的 agent 作用域上下文调一次枢纽的 setup
 * （宿主 `agents.create/resume` 走的就是同一条路），把定义收出来。自带 recorder，并复原
 * `mind.stats.lastSetup`，不污染真实会话的统计。
 */
function probeHub(who, opts = {}) {
  const rec = { agentTools: [], agentSections: [], contexts: [], effects: [], agentEvents: [] };
  const before = who?.mind?.stats?.lastSetup;
  try {
    who.mind.setup?.(fakeAgentCtx(rec, opts), { reply: () => null, sessionKey: 'group:10000', agentKey: 'agent:group:10000' });
  } catch (err) {
    console.error(`[probe] 枢纽 setup 探针失败：${String(err?.message ?? err)}`);
  }
  if (who?.mind?.stats) who.mind.stats.lastSetup = before;
  return rec;
}
const hubProbe = probeHub(hub);
const hubTools = () => hubProbe.agentTools;
const hubSections = () => hubProbe.agentSections;
/**
 * m11162：正常探针里直发版 `onebot_reply` 是**刻意让位**的那个（会话缓冲版占着这个名字；硬撞会让
 * 宿主抛错并连坐后面 22 个注册），所以要验直发版本体，得走"会话版挂不上"的那一套。
 */
const hubDirectProbe = probeHub(hub, { failFirstRegister: true });
const hubDirectReply = () => hubDirectProbe.agentTools.find((t) => t.name === 'onebot_reply');

check('插件名与依赖声明', () => {
  assert.equal(name, 'dsh-onebot-hub');
  assert.deepEqual(inject, ['webServer', 'tools']);
});

/** 取出 volatile 字段的真值（`Config(...)` 对带 volatile 的字段返回稳定引用，用 `.get()` 读）。 */
const plainConfig = (value) => (value && typeof value.get === 'function' ? value.get() : value);

check('Config schema 能填默认值', () => {
  const filled = Config({});
  assert.equal(plainConfig(filled.agent.mode), 'assist');
  assert.equal(plainConfig(filled.agent.batchSize), 10);
  assert.equal(plainConfig(filled.agent.batchMs), 20000);
  // issue #1：会话归属默认**什么都不改**——不进工作区、结束即归档。
  assert.equal(plainConfig(filled.agent.workspace), '');
  assert.equal(plainConfig(filled.agent.archiveOnRetire), true);
  // `m18072` 用户定案：默认档位由 scoped 改 balanced（活跃层要开箱能跨共享会话看见彼此的话题）。
  assert.equal(plainConfig(filled.memory.isolation.level), 'balanced');
  // `m22311` 用户定案：私聊事实默认改 sameActor（同一个人在别的私聊里能看见）。
  assert.equal(plainConfig(filled.memory.isolation.privateFacts), 'sameActor');
  // 活跃层（`m17909`）默认开着，「待结算」每天提一次。
  assert.equal(plainConfig(filled.memory.active.enabled), true);
  assert.equal(plainConfig(filled.memory.active.activeWindowDays), 30);
  assert.equal(plainConfig(filled.memory.active.injectLimit), 8);
  assert.equal(plainConfig(filled.memory.active.maxPerOrigin), 20);
  assert.equal(plainConfig(filled.memory.active.dailySettleReminder), true);
  // 【本群认识的人】默认列 20 人（`m09409` 用户要求"不写死"→ 走配置项，0 才是关）
  assert.equal(plainConfig(filled.memory.peopleRoster), 20);
  assert.equal(plainConfig(filled.media.enabled), true);
  assert.equal(plainConfig(filled.media.transcribe), true);
  assert.equal(plainConfig(filled.learn.threshold), 3);
  assert.equal(plainConfig(filled.learn.forgetAfter), 6);
  assert.equal(plainConfig(filled.cards.maxLines), 40);
  assert.equal(plainConfig(filled.cards.maxSessions), 200);
  assert.equal(plainConfig(filled.members.enabled), true);
  assert.equal(plainConfig(filled.members.cooldownMs), 6 * 60 * 60 * 1000);
  assert.equal(plainConfig(filled.members.maxPerMessage), 5);
  assert.equal(plainConfig(filled.members.maxQueue), 50);
  assert.equal(plainConfig(filled.vision.mode), 'describe');
  // 识图默认模型由 hub 配置决定（m024167）：`agent.defaultVisionModel` 没配 = 系统默认模型，
  // 配了才指定 provider/model（会话里 /vmodel 仍可覆盖）。maxTokens 默认 0 = 不传该参数，描述不做长度闸（m24155）。
  assert.equal(plainConfig(filled.vision.maxTokens), 0);
  assert.equal(plainConfig(filled.vision.timeoutMs), 30000);
  assert.equal(plainConfig(filled.vision.cacheLimit), 500);
  assert.equal(plainConfig(filled.upstreamNickname), '');
  // hub 配置的默认路由（m024167）：留空 = 跟 DSH 系统默认。
  assert.equal(plainConfig(filled.agent.defaultModel), '');
  assert.equal(plainConfig(filled.agent.defaultVisionModel), '');
  // 会话白名单（m31030）：JSON 字符串、默认空数组 = 生产默认 deny-all（设置页行编辑器拼这个字符串）。
  assert.equal(plainConfig(filled.agent.groups), '[]');
  assert.equal(plainConfig(filled.agent.privates), '[]');
  // 插话（m31311）：默认开——回合在飞时新消息直接递进正在进行的回合（宿主 `steer`/next-step）。
  assert.equal(plainConfig(filled.agent.steer), true);
  // 一次回复发多条（m32420）：默认 3 条文字 + 9 张图，隔 400ms；0 = 不限。
  assert.equal(plainConfig(filled.agent.replyGapMs), 400);
  assert.equal(plainConfig(filled.agent.replyMaxText), 3);
  assert.equal(plainConfig(filled.agent.replyMaxImages), 9);
  // 生图引擎与发送时机（用户 2026-10-11 定）：默认 builtin + agent。
  assert.equal(plainConfig(filled.imageGen.enabled), false);
  assert.equal(plainConfig(filled.imageGen.engine), 'builtin');
  assert.equal(plainConfig(filled.imageGen.delivery), 'agent');
  assert.equal(plainConfig(filled.imageGen.plugin.tool), '');
  assert.equal(plainConfig(filled.imageGen.plugin.timeoutMs), 180000);
  // 分群额度（m14190）：**没有全局额度块**了 —— 口径/单价/限额/报数都挂在
  // `groups`/`privates` 白名单每一行的 `quota` 上，没勾"启用"的行＝不限。
  assert.equal(plainConfig(filled.agent.quota), undefined, '别把全局额度块加回来（额度按群逐行配）');
});

check('设置页文字：每一个配置项在 client.js 里都有中文名与说明，且不多不少', () => {
  // 设置页的字段文字是**浏览器半侧**维护的（客户端不能 import 宿主代码），所以它和 schema
  // 是两份东西——这里拿真 schema 的叶子清单去对账：少一条、多一条、或者哪条没写中文，都红。
  const source = fs.readFileSync(path.join(here, '..', 'lib', 'client.js'), 'utf8');
  const fieldText = extractJsonObject(source, 'const FIELD_TEXT = ');
  const leaves = [];
  const walk = (node, trail) => {
    if (!node) return;
    if (node.dict && typeof node.dict === 'object' && Object.keys(node.dict).length > 0) {
      for (const [key, child] of Object.entries(node.dict)) walk(child, [...trail, key]);
      return;
    }
    leaves.push(trail.join('.'));
  };
  walk(Config, []);
  assert.ok(leaves.length >= 100, `schema 叶子太少（${leaves.length}），对账就没意义了`);
  const mapKeys = Object.keys(fieldText);
  const missing = leaves.filter((key) => !mapKeys.includes(key));
  const extra = mapKeys.filter((key) => !leaves.includes(key));
  assert.deepEqual(missing, [], `这些配置项在 client.js 的 FIELD_TEXT 里没有中文说明：${missing.join(', ')}`);
  assert.deepEqual(extra, [], `FIELD_TEXT 里有 schema 里不存在的键（改配置时忘了删）：${extra.join(', ')}`);
  const han = /[\u4e00-\u9fff]/;
  for (const [key, entry] of Object.entries(fieldText)) {
    assert.ok(entry && typeof entry.label === 'string' && han.test(entry.label), `${key} 没有中文名`);
    assert.ok(typeof entry.note === 'string' && han.test(entry.note) && entry.note.length >= 6, `${key} 的说明太短或不是中文：${entry.note}`);
  }
});

check('配置文档：docs/config.md 里每个 schema 叶子都有一行，且没有多余的键', () => {
  // 文档也会漂移：加了配置项忘了写进 docs/config.md，读者就查不到它管什么。这里拿真 schema 的
  // 叶子清单去对账（键 = 表格第一列的反引号内容），少一行、多一行都红。
  const doc = fs.readFileSync(path.join(here, '..', 'docs', 'config.md'), 'utf8');
  const listed = new Set();
  for (const line of doc.split('\n')) {
    const m = /^\|\s*`([A-Za-z][\w.]*)`\s*\|/.exec(line);
    if (m) listed.add(m[1]);
  }
  const leaves = [];
  const walk = (node, trail) => {
    if (!node) return;
    if (node.dict && typeof node.dict === 'object' && Object.keys(node.dict).length > 0) {
      for (const [key, child] of Object.entries(node.dict)) walk(child, [...trail, key]);
      return;
    }
    leaves.push(trail.join('.'));
  };
  walk(Config, []);
  const missing = leaves.filter((key) => !listed.has(key));
  const extra = [...listed].filter((key) => !leaves.includes(key));
  assert.deepEqual(missing, [], `这些配置项没写进 docs/config.md：${missing.join(', ')}`);
  assert.deepEqual(extra, [], `docs/config.md 里有 schema 中不存在的键（改配置时忘了删）：${extra.join(', ')}`);
});

check('多下游目标：normalizeTargets 保留启用位、id 去重、容忍缺字段与坏 JSON', () => {
  // §19 多下游的配置面：一条目标 = 一个 id（缺省 selfId）+ 自己的 url/token/重连间隔/enabled。
  const parsed = normalizeTargets(JSON.stringify([
    { url: 'ws://127.0.0.1:8080/onebot/v11/ws', selfId: '30001', nickname: 'a', accessToken: 'tok' },
    { url: 'ws://127.0.0.1:8081/onebot/v11/ws', selfId: '30001' },
    { url: 'ws://127.0.0.1:8082/onebot/v11/ws', selfId: '30003', enabled: false, reconnect_interval: 1234 },
    { id: 'fixed-id', url: 'ws://127.0.0.1:8083/onebot/v11/ws', selfId: '30004' },
    { url: 'ws://127.0.0.1:8084/onebot/v11/ws' },
    { selfId: '30005' },
    'not-an-object',
  ]));
  assert.deepEqual(parsed.map((t) => t.id),
    ['30001', '30001#2', '30003', 'fixed-id', '127.0.0.1:8084'],
    '同 selfId 的目标必须各自可寻址；没写账号的拨号型也留着（等上游账号，见 hub.learnUpstreamAccount）');
  assert.equal(parsed[4].pendingAccount, true, '没写账号、也没默认账号 → 标"在等上游账号"');
  assert.equal(parsed[4].selfId, '', '不知道账号就是空串，不猜');
  assert.equal(parsed[0].enabled, true, 'enabled 缺省为 true');
  assert.equal(parsed[0].accessToken, 'tok');
  assert.equal(parsed[2].enabled, false, 'enabled:false 必须留着（状态里要显示"配了没拨"）');
  assert.equal(parsed[2].reconnectInterval, 1234, '每条目标可以有自己的重连间隔');
  assert.equal(parsed[3].id, 'fixed-id', '显式 id 优先');
  assert.equal(parsed[0].reconnectInterval, undefined, '没写就是 undefined（走全局默认）');
  assert.deepEqual(normalizeTargets(''), []);
  assert.deepEqual(normalizeTargets('{坏 JSON'), []);
  assert.deepEqual(normalizeTargets({}), []);
});

check('下游目标不写"对方账号" = 与上游相同（defaultSelfId = upstreamSelfId）', () => {
  const raw = JSON.stringify([
    { url: 'ws://127.0.0.1:8080/onebot/v11/ws' },
    { type: 'http-post', address: '127.0.0.1:9090/x' },
    { type: 'ws-listen', address: '127.0.0.1:0/onebot/v11/ws' },
    { url: 'ws://127.0.0.1:8081/onebot/v11/ws', selfId: '30009' },
    { url: 'ws://127.0.0.1:8082/onebot/v11/ws' },
  ]);
  const filled = normalizeTargets(raw, { defaultSelfId: '3371846367' });
  assert.equal(filled.length, 5, '配了上游账号时，没写账号的拨号型不该再被跳过');
  assert.deepEqual(filled.map((t) => t.selfId),
    ['3371846367', '3371846367', '3371846367', '30009', '3371846367'], '不写就取上游账号，写了就听写的');
  assert.deepEqual(filled.map((t) => t.id),
    ['127.0.0.1:8080', '127.0.0.1:9090', '127.0.0.1:0', '30009', '127.0.0.1:8082'],
    'id 只认显式 selfId，没写就落到地址——否则几条"默认账号"的目标会互相挤成 #2');
  assert.equal(filled[2].port, 0, '监听型允许 0 端口（由系统分配）');
  // 上游账号**也还不知道**（配置没写、上游还没连上）：不丢条目、也**不编造**账号——照旧登记，
  // 标 `pendingAccount`，hub 先不建链，等学到账号再补建（见 hub.learnUpstreamAccount）。
  const empty = normalizeTargets(raw, { defaultSelfId: '' });
  assert.deepEqual(empty.map((t) => t.id),
    ['127.0.0.1:8080', '127.0.0.1:9090', '127.0.0.1:0', '30009', '127.0.0.1:8082'],
    '没上游账号：条目全部保留（不再静默丢弃），拨号型等账号、监听型照旧能用');
  assert.deepEqual(empty.map((t) => t.selfId), ['', '', '', '30009', ''],
    '不知道就是空串——绝不猜一个账号出来');
  assert.deepEqual(empty.map((t) => t.pendingAccount === true),
    [true, true, false, false, true],
    '只有"拨号/POST 型 + 账号空着"才标在等账号（监听型不需要账号）');
  // 整条路径：resolveConfig 必须真的把 upstreamSelfId 传下去（而不是只写在文档里）
  const resolved = resolveConfig({
    upstreamSelfId: '3371846367',
    downstreamTargets: JSON.stringify([{ url: 'ws://127.0.0.1:8080/onebot/v11/ws' }]),
  });
  assert.equal(resolved.downstreamTargets.length, 1, 'resolveConfig 没把上游账号传下去');
  assert.equal(resolved.downstreamTargets[0].selfId, '3371846367');
  assert.equal(resolved.downstreamTargets[0].pendingAccount, undefined, '账号有了就不再是"等账号"');
  const noUpstream = resolveConfig({ downstreamTargets: JSON.stringify([{ url: 'ws://127.0.0.1:8080/onebot/v11/ws' }]) });
  assert.equal(noUpstream.downstreamTargets.length, 1, '上游账号空着时这条链不该被扔掉——要留着等账号');
  assert.equal(noUpstream.downstreamTargets[0].selfId, '', '账号不知道就是空串');
  assert.equal(noUpstream.downstreamTargets[0].pendingAccount, true, '标记成"等上游账号"');
});

check('上游监听地址自带路径：parseListenTarget 认 host:port/path，upstreamListenPath 已从 schema 移除', () => {
  // 用户要求：不要再单独配"监听路径"，一个 upstreamListen 说完整。
  assert.equal(Config.dict.upstreamListenPath, undefined, '路径不该再单独配置（已并进 upstreamListen）');
  const cases = [
    ['127.0.0.1:14514/onebot/v11/ws', { host: '127.0.0.1', port: 14514, path: '/onebot/v11/ws' }],
    ['ws://127.0.0.1:14514/onebot/v11/ws', { host: '127.0.0.1', port: 14514, path: '/onebot/v11/ws' }],
    ['wss://bot.example.com:443/x/ws', { host: 'bot.example.com', port: 443, path: '/x/ws' }],
    [':14514/onebot/v11/ws', { host: '127.0.0.1', port: 14514, path: '/onebot/v11/ws' }],
    ['14514/onebot/v11/ws', { host: '127.0.0.1', port: 14514, path: '/onebot/v11/ws' }],
    ['127.0.0.1:14514/onebot/v11/ws?token=abc', { host: '127.0.0.1', port: 14514, path: '/onebot/v11/ws' }],
    ['127.0.0.1:14514/onebot/v11/ws/', { host: '127.0.0.1', port: 14514, path: '/onebot/v11/ws/' }],
    ['  127.0.0.1:14514/ws  ', { host: '127.0.0.1', port: 14514, path: '/ws' }],
    // 没写路径 = 根路径（写什么就是什么，不偷偷补 /onebot/v11/ws）
    ['127.0.0.1:14514', { host: '127.0.0.1', port: 14514, path: '/' }],
    ['14514', { host: '127.0.0.1', port: 14514, path: '/' }],
    [':14514', { host: '127.0.0.1', port: 14514, path: '/' }],
    ['127.0.0.1:14514/', { host: '127.0.0.1', port: 14514, path: '/' }],
    ['ws://127.0.0.1:14514', { host: '127.0.0.1', port: 14514, path: '/' }],
    ['', null],
    ['   ', null],
    ['onebot/v11/ws', null],
    ['127.0.0.1:0/x', null],
    ['127.0.0.1:70000/x', null],
    ['127.0.0.1:abc/x', null],
  ];
  for (const [input, want] of cases) {
    const got = parseListenTarget(input);
    assert.deepEqual(got, want, `parseListenTarget(${JSON.stringify(input)}) = ${JSON.stringify(got)}，期望 ${JSON.stringify(want)}`);
  }
  // 走一遍 resolveConfig：监听地址解析出来的对象里就带着 path，hub 直接拿它启动监听。
  const resolved = resolveConfig({ upstreamListen: '127.0.0.1:14514/onebot/v11/ws' });
  assert.deepEqual(resolved.upstreamListen, { host: '127.0.0.1', port: 14514, path: '/onebot/v11/ws' });
  assert.equal('upstreamListenPath' in resolved, false, '解析后的配置里不该再有 upstreamListenPath');
  assert.equal(resolveConfig({ upstreamListen: '' }).upstreamListen, null, '留空 = 不监听');
  // 老 profile 里多半还留着 upstreamListenPath：不许因此报错（schemastery 会把未知键原样留着），
  // 也不许它继续起作用——路径一律以 upstreamListen 里写的为准。
  const legacy = Config({ upstreamListenPath: '/legacy', upstreamListen: '127.0.0.1:14514/custom' });
  assert.equal(legacy.upstreamListenPath, '/legacy', '未知键被原样留着（无害），但不能进设置页');
  assert.deepEqual(
    resolveConfig(legacy).upstreamListen,
    { host: '127.0.0.1', port: 14514, path: '/custom' },
    '旧的 upstreamListenPath 不再参与解析',
  );
});

check('上游监听地址与下游列表**没有默认值**（没配就是没这一项，运行时不猜）', () => {
  // 用户要求：这两项不要"默认值"。schema 里去掉 `.default(...)` 后，没配过的 profile 里
  // 这两个键**不存在**（设置页靠 client.js 的 ALWAYS_FIELDS 补空行，运行时由 resolveConfig 兜底）。
  // 断言看 `meta.default`：有默认值的节点会带这个标记（下面拿 upstreamUrl/preset 当对照）。
  assert.equal(Config.dict.upstreamListen.meta.default, undefined, 'upstreamListen 不该有默认值');
  assert.equal(Config.dict.downstreamTargets.meta.default, undefined, 'downstreamTargets 不该有默认值');
  assert.equal(Config.dict.upstreamUrl.meta.default, '', '对照组：upstreamUrl 仍然有默认空串');
  assert.equal(Config.dict.preset.meta.default, 'relay', '对照组：preset 仍然有默认值');
  assert.ok(Config.dict.upstreamListen && Config.dict.downstreamTargets, '两项仍要在 schema 里，否则设置页无法渲染');
  const resolved = resolveConfig({});
  assert.equal(resolved.upstreamListen, null, '没配 = 不监听');
  assert.deepEqual(resolved.downstreamTargets, [], '没配 = 没有下游目标');
  assert.deepEqual(normalizeTargets(''), [], '空串也当没有目标（老 profile 里可能存着 ""）');
  assert.deepEqual(normalizeTargets('[]'), [], '老默认值 "[]" 照样读得回来');
});

check('只读开关：readonly 是**真的配置项**，且只能打开、关不掉预设自带的那份', () => {
  // 背景：以前 `shadow` 预设的 `event.readonly` 没有任何消费者，而"配置里的 readonly"根本
  // 不在 schema 里（`config.readonly` 永远 undefined）——文案说了、代码没做。这里把两头钉住。
  assert.equal(Config.dict.readonly.meta.default, false, 'readonly 默认关（预设自带的那份由 router 兜）');
  assert.equal(Config.dict.readonly.meta.volatile, true, '设置页要能改它，否则等于没有');
  assert.equal(resolveConfig({}).readonly, false, '没配 = 不额外打开只读');
  assert.equal(resolveConfig({ readonly: true }).readonly, true, '配了 true 要原样传给 hub（策略层读它）');

  assert.equal(resolvePolicy({ preset: 'shadow' }).event.readonly, true, 'shadow 预设自带只读');
  assert.equal(resolvePolicy({ preset: 'shadow', readonly: false }).event.readonly, true, '配置写 false 关不掉预设的只读');
  assert.equal(resolvePolicy({ preset: 'relay', readonly: true }).event.readonly, true, '任何预设都能显式打开只读');
  assert.equal(resolvePolicy({ preset: 'bridge' }).event.readonly, false, 'bridge 不是只读：它要真的动手');

  // `both` / `captureAll` 是同一批"说了没做"：前者以前和 relay 落进同一个分支，后者根本不是配置项。
  assert.equal(resolvePolicy({ preset: 'bridge' }).action['*'], 'both', 'bridge 的 action 策略是真 both');
  assert.equal(resolvePolicy({ preset: 'relay' }).action['*'], 'capture', 'relay 的兜底仍是 capture');
  const described = describePolicy(resolvePolicy({ preset: 'shadow' }));
  assert.equal(described.readonly, true, 'describePolicy 要报出只读（状态页/agent 都读它）');
  assert.ok(!('captureAll' in described), 'describePolicy 不再报那个从来不是配置项的名字');
  assert.ok(!('deliverToSelf' in described), 'describePolicy 不再报那个真实字段的重复名字');
});

check('设置页可编辑面：配置字段都标了 volatile，凭据字段标了 secret', () => {
  // 宿主 `@deepseek-ai/dsh-settings` 的 `volatileForm()` 只投影"带 volatile 的字段"，
  // 所以「设置 → 插件」里能改哪些项，完全由这个标记决定。抽查各配置族的代表字段。
  const live = [
    Config.dict.upstreamListen,
    Config.dict.downstreamHeartbeatMs,
    Config.dict.agent.dict.mode,
    Config.dict.agent.dict.guidance,
    Config.dict.capability.dict.writeAllow,
    Config.dict.memory.dict.isolation.dict.level,
    Config.dict.vision.dict.mode,
    Config.dict.persona.dict.presets,
    Config.dict.chatCommands.dict.superUsers,
    Config.dict.memes.dict.autoCollect,
    Config.dict.anime.dict.backend,
    Config.dict.imageGen.dict.model,
  ];
  for (const [index, field] of live.entries()) {
    assert.equal(field?.meta?.volatile, true, `第 ${index} 个抽查字段没有 volatile，设置页里就改不了`);
  }
  // 对象节点本身**不能**标 volatile：那会把整棵子树包成一个引用，取值直接坏掉。
  assert.notEqual(Config.dict.agent.meta?.volatile, true, '对象节点不该标 volatile');
  assert.notEqual(Config.meta?.volatile, true, '根节点不该标 volatile');
  // 凭据不能被回显：这四处必须是 role('secret')（设置页只显示"设过没设过"）。
  assert.equal(Config.dict.upstreamAccessToken.meta.role, 'secret');
  assert.equal(Config.dict.downstreamAccessToken.meta.role, 'secret');
  assert.equal(Config.dict.anime.dict.recognizeToken.meta.role, 'secret');
  assert.equal(Config.dict.imageGen.dict.apiKey.meta.role, 'secret');
  // 普通字段不能误标成 secret（标错等于把配置项变成只读的占位符）。
  assert.equal(Config.dict.upstreamListen.meta.role, undefined);
  assert.equal(Config.dict.imageGen.dict.model.meta.role, undefined);
  // 配置族别被悄悄删：顶层分组数是用户在设置页里能看到的"分了几块"。
  const keys = Object.keys(Config.dict);
  assert.ok(keys.length >= 25, `顶层配置分组太少：${keys.length}`);
  for (const key of keys) assert.ok(Config.dict[key], `分组 ${key} 的 schema 丢了`);
});

check('clientModules 体检：拿不到服务不编，拿得到时报出浏览器半侧的路径与行', () => {
  // 设置页空白时靠它区分"页面没加载"与"页面加载了但渲染失败"，所以这两条分支都要钉住。
  assert.deepEqual(auditClientModules({}), { available: false, note: '宿主没有 clientModules 服务（非 web 组合？）' });
  const fakeCtx = {
    get(service) {
      if (service !== 'clientModules') return undefined;
      return {
        clientPath: (id) => `/plugins/${id}/client.js`,
        graph: () => ({ rows: [{ id: 'dsh-onebot-hub' }, { id: 'dsh-client-ui-settings' }] }),
        artifactBaseline: () => 'abc123',
      };
    },
  };
  const audit = auditClientModules(fakeCtx);
  assert.equal(audit.available, true);
  assert.equal(audit.path, '/plugins/dsh-onebot-hub/client.js');
  assert.deepEqual(audit.hubRows, ['dsh-onebot-hub']);
  assert.equal(audit.baseline, 'abc123');
});

check('resolveConfig 暴露 selfId/nickname 别名', () => {
  const cfg = resolveConfig({ upstreamSelfId: '30001000', upstreamNickname: 'hub-bot' });
  assert.equal(cfg.selfId, '30001000');
  assert.equal(cfg.nickname, 'hub-bot');
  assert.equal(resolveConfig({ upstreamSelfId: '30001000' }).nickname, undefined);
});

check('hub 配置的默认模型（m024167）：provider/model 解析，留空/认不出 = null（跟系统默认）', () => {
  assert.deepEqual(parseModelRef('volcengine/doubao-vision-pro'), { provider: 'volcengine', model: 'doubao-vision-pro' });
  assert.deepEqual(parseModelRef('只写模型名'), { provider: '', model: '只写模型名' }, '只给 model 时 provider 留空（由调用方沿用）');
  assert.equal(parseModelRef(''), null, '留空 = 没配');
  assert.equal(parseModelRef('   '), null);
  assert.equal(parseModelRef('只有provider/'), null, '没有模型名不许猜');
  const cfg = resolveConfig({ agent: { defaultModel: 'volcengine/doubao-vision-pro', defaultVisionModel: 'a/b' } });
  assert.deepEqual(cfg.agentDefaultModel, { provider: 'volcengine', model: 'doubao-vision-pro' });
  assert.deepEqual(cfg.agentDefaultVisionModel, { provider: 'a', model: 'b' });
  const bare = resolveConfig({});
  assert.equal(bare.agentDefaultModel, null, '没配 = null');
  assert.equal(bare.agentDefaultVisionModel, null);
});

check('imageGen engine/delivery/plugin 配置归一（用户 2026-10-11 定）', () => {
  const bare = resolveConfig({});
  assert.equal(bare.imageGen.engine, 'builtin', '默认引擎 = builtin（老行为）');
  assert.equal(bare.imageGen.delivery, 'agent', '默认发送时机 = agent（生成后由 agent 决定发不发）');
  assert.deepEqual(bare.imageGen.plugin.tool, [], '默认不点名第三方工具');
  assert.equal(bare.imageGen.plugin.timeoutMs, 180000);
  const custom = resolveConfig({
    imageGen: {
      engine: 'plugin',
      delivery: 'direct',
      plugin: { tool: 'generate_image, image_generate', timeoutMs: 1500 },
    },
  });
  assert.equal(custom.imageGen.engine, 'plugin');
  assert.equal(custom.imageGen.delivery, 'direct');
  assert.deepEqual(custom.imageGen.plugin.tool, ['generate_image', 'image_generate'], '逗号分隔拆开并去空白');
  assert.equal(custom.imageGen.plugin.timeoutMs, 1500);
  assert.equal(resolveConfig({ imageGen: { plugin: { timeoutMs: 999 } } }).imageGen.plugin.timeoutMs, 1000, '过小的超时钳到 1000');
  const weird = resolveConfig({ imageGen: { engine: 'wat', delivery: 'wat', plugin: { tool: ['a', '', 'b'] } } });
  assert.equal(weird.imageGen.engine, 'builtin', '认不出的引擎值回退 builtin');
  assert.equal(weird.imageGen.delivery, 'agent', '认不出的发送时机回退 agent');
  assert.deepEqual(weird.imageGen.plugin.tool, ['a', 'b'], '数组写法滤空');
});

check('apply 返回 hub 并挂出内部件', () => {
  assert.ok(hub && typeof hub === 'object');
  for (const key of ['mind', 'store', 'pool', 'timeline']) assert.ok(hub[key], `缺 ${key}`);
  assert.equal(hub.mind.selfId, '30001000');
});

check('注册了 28 个工具且形状合法', () => {
  assert.equal(hubTools().length, 28);
  const names = hubTools().map((t) => t.name).sort();
  assert.deepEqual(names, [
    'onebot_admin',
    'onebot_avatar',
    'onebot_call',
    'onebot_capabilities',
    'onebot_caps',
    'onebot_capture',
    'onebot_code_scopes',
    'onebot_context',
    'onebot_group',
    'onebot_hub_status',
    'onebot_imagegen',
    'onebot_invoke',
    'onebot_media',
    'onebot_members',
    'onebot_memes',
    'onebot_memory',
    'onebot_memory_audit',
    'onebot_person',
    'onebot_profile',
    'onebot_raw',
    'onebot_recall',
    'onebot_relay_probe',
    'onebot_reply',
    'onebot_sessions',
    'onebot_timeline',
    'onebot_tools',
    'onebot_topic',
    'onebot_turns',
  ]);
  for (const def of hubTools()) {
    assert.equal(typeof def.description, 'string');
    assert.equal(typeof def.execute, 'function');
    assert.ok(def.output?.schema, `${def.name} 缺 output.schema`);
    assert.equal(typeof def.output.render, 'function');
    assert.ok(def.parameters && typeof def.parameters === 'object');
  }
});

// m10863：28 个工具与枢纽指导段都挂在**会话装配的 agent 作用域**（`setup(agentCtx)`），
// profile 全局层一个都不留。这就是"子代理与非枢纽会话看不见 onebot_*"的机制：宿主 `dsh-scope`
// 的视图 = global + 本 scope 的链，而 agent 的 scope 没有父链（`dsh-agent-loop` 里
// `createScope(loopCtx, this)` 不传 parent、`bindScopeParent` 零调用者），
// 所以子代理即便 join 了父预设，也拿不到父 agent 的 scoped 注册。
check('枢纽工具只挂在会话装配的 agent 作用域，profile 全局层一个都不留（m10863）', () => {
  assert.deepEqual(recorded.globalTools, [], 'apply 阶段不该往全局层注册工具：那会让每个 DSH 会话都看见 onebot_*');
  assert.equal(hubTools().length, 28, '会话装配（宿主 create/resume 走的就是同一条路）里应当收全 28 个');
  assert.deepEqual(hubSections().map((s) => s.name), ['plugin:dsh-onebot-hub'], '指导段同理：只跟着枢纽会话走，不再是全局段落');
  // m11162 真机事故：同名工具硬撞会让宿主抛错并**连坐**后面 22 个注册（真机会话里只剩 6 个 onebot_*）。
  // 现在 setup 主动让位：会话缓冲版占 `onebot_reply`，直发版不注册（它的本体在 hubDirectProbe 里验）。
  assert.equal(
    hubTools().find((t) => t.name === 'onebot_reply')?.parameters.group_id,
    undefined,
    '占住 onebot_reply 的应当是会话缓冲版（绑这一轮 reply 句柄），直发版让位',
  );
});

check('会话版回复工具挂不上时，直发版 onebot_reply 顶位（m11162 让位规则不能把能力让没）', () => {
  const direct = hubDirectReply();
  assert.ok(direct, '直发版应当注册：会话版一坏，回复能力不能整个丢');
  assert.ok(direct.parameters.group_id, '直发版要能发到指定目标（group_id / user_id）');
  assert.equal(hubDirectProbe.agentTools.length, 28, '让位场景下同样该收全 28 个工具');
});

await checkAsync('下游源码范围（可多条）+ 位置不进 prompt：agent 需要时调 onebot_code_scopes 取（m14477）', async () => {
  const toolOf = (n) => hubTools().find((t) => t.name === n);

  // —— 配置：多条范围，JSON 数组；老写法（一行一个路径）也认 ——
  assert.deepEqual(resolveConfig({}).codeScopes, [], '没填 = 空');
  assert.deepEqual(
    resolveConfig({ code: { scopes: '[{"name":"下游A","path":"D:/a"},{"path":"D:/b"}]' } }).codeScopes,
    [{ name: '下游A', path: 'D:/a' }, { name: '', path: 'D:/b' }],
  );
  assert.deepEqual(
    resolveConfig({ code: { scopes: 'D:/a\n\n备注B = D:/b\nD:/a' } }).codeScopes,
    [{ name: '', path: 'D:/a' }, { name: '备注B', path: 'D:/b' }],
    '一行一个路径也认（等号左边当备注），空行不算，重复路径去掉',
  );
  assert.deepEqual(parseCodeScopes('["D:/a","D:/b"]'), [{ name: '', path: 'D:/a' }, { name: '', path: 'D:/b' }], 'JSON 字符串数组也认');
  assert.deepEqual(parseCodeScopes('[{"path":"D:/a"'), [{ name: '', path: 'D:/a' }], 'JSON 坏了不丢配置，退回按行解析');
  assert.deepEqual(parseCodeScopes('[{"dir":"D:/a","label":"x"},{"path":"D:/a","name":"y"}]'), [{ name: 'x', path: 'D:/a' }], '同路径去重，先出现的备注留下');
  assert.deepEqual(parseCodeScopes(''), []);
  assert.deepEqual(parseCodeScopes(undefined), []);
  assert.deepEqual(parseCodeScopes(['  ', { path: '' }]), []);
  assert.equal(describeCodeScopes([{ name: '下游A', path: 'D:/a' }, { name: '', path: 'D:/b' }]).join('、'), '下游A（D:/a）、D:/b');

  // —— 指导段：路径**不进 prompt**，只说"去调 onebot_code_scopes" ——
  assert.equal(buildHubGuidance({}).includes('onebot_scan_code'), false, '自带扫描器已移除，指导段不该再提它');
  assert.equal(buildHubGuidance({ codeScopes: [] }).includes('onebot_code_scopes'), false, '没配范围就一个字都不提');
  const guided = buildHubGuidance({ codeScopes: [{ name: '下游A', path: 'D:\\secret\\bot' }] });
  assert.ok(guided.includes('onebot_code_scopes'), '配了范围就指向那个工具');
  assert.equal(guided.includes('D:\\secret\\bot'), false, '路径本身不进 prompt');
  assert.equal(guided.includes('下游A'), false, '备注也不进 prompt');

  // —— 指导段：排查纪律（m30055）与看图绕道禁令（onebot_tools 是后门，仅 describe/off 档提）——
  const plainGuidance = buildHubGuidance({});
  assert.ok(plainGuidance.includes('排查类问题要快出结论'), '排查纪律进指导段（不限识图档）');
  assert.ok(plainGuidance.includes('onebot_turns'), '排查给的是 onebot_turns 一轮出结论的路子');
  assert.ok(plainGuidance.includes('更不要绕道看图') && plainGuidance.includes('onebot_tools'), 'describe 档禁 onebot_tools 开 read_image 绕道');
  const segmentGuidance = buildHubGuidance({ vision: { mode: 'segment' } });
  assert.ok(segmentGuidance.includes('排查类问题要快出结论'), '排查纪律不受识图档影响');
  assert.equal(segmentGuidance.includes('更不要绕道看图'), false, 'segment 档模型看得见图，绕道禁令不该出现');

  // —— 指导段：权限不够怎么开口要（m33950）——
  const permGuidance = buildHubGuidance({ chatCommands: { prefix: '.', superUsers: ['10001'] } });
  assert.ok(permGuidance.includes('权限不够就开口要'), '要教 agent 开口要权限');
  assert.ok(permGuidance.includes('.perm <预设名>'), '命令前缀要跟着配置走（配了 . 就不能写 /perm）');
  assert.ok(permGuidance.includes('只对这一次唤醒有效'), '要说明授权不持久，免得它以为上次给过就行');
  assert.equal(permGuidance.includes('/perm'), false, '默认前缀不出现：这份配置用的就是 .');
  assert.equal(permGuidance.includes('workspace-write'), true, '要给出可用预设名，否则它不知道要什么');
  const noAdminGuidance = buildHubGuidance({ chatCommands: { superUsers: [] } });
  assert.ok(noAdminGuidance.includes('权限不够就如实说'), '没超管名单时改成"如实说缺什么"');
  assert.ok(noAdminGuidance.includes('没有配聊天管理命令的超管名单'), '名单为空就别教它命令表');
  assert.equal(noAdminGuidance.includes('.perm') || noAdminGuidance.includes('/perm'), false, '没人能执行的命令不许教');
  const scopedPermGuidance = buildHubGuidance({ codeScopes: [{ name: '下游A', path: 'D:/x' }], chatCommands: { prefix: '/', superUsers: ['10001'] } });
  assert.ok(scopedPermGuidance.includes('/perm read-only'), '默认前缀下要给 read-only 的对应写法');
  assert.ok(scopedPermGuidance.includes('开口要权限'), '读源码那条也不能再说"如实说没权限读"就完事');

  // —— 工具本体：真去 stat，缺的如实报 missing ——
  const scopes = JSON.parse(await toolOf('onebot_code_scopes').execute({}));
  assert.equal(scopes.count, 2);
  assert.equal(scopes.scopes[0].name, '下游A');
  assert.equal(scopes.scopes[0].path, repoDir);
  assert.equal(scopes.scopes[0].exists, true);
  assert.equal(scopes.scopes[0].kind, 'dir');
  assert.equal(scopes.scopes[1].exists, false, '不存在的路径如实报');
  assert.equal(scopes.scopes[1].kind, 'missing');
  assert.ok(scopes.note.includes('权限'));
  const alt = makeCtx();
  const altHub = apply(alt.ctx, {
    upstreamUrl: '',
    upstreamSelfId: '30001000',
    downstreamTargets: '[]',
    persist: false,
    code: { scopes: '[{"name":"下游A","path":"D:/不存在的目录/xyz"},{"path":"' + process.cwd().replace(/\\/g, '/') + '"}]' },
  });
  await sleep(60);
  const altProbe = probeHub(altHub);
  const altTools = altProbe.agentTools;
  const altSections = altProbe.agentSections;
  try {
    // 自带扫描器已移除：两个实例的工具数一样（28），都不该有 onebot_scan_code。
    assert.equal(altTools.length, 28, '工具数应当与主实例一致（扫描器已移除）');
    assert.equal(altTools.some((t) => t.name === 'onebot_scan_code'), false, '扫描器工具已移除');
    const section = altSections.find((s) => s.name === 'plugin:dsh-onebot-hub');
    assert.equal(section?.order, 160);
    assert.equal(typeof section.text, 'string');
    assert.ok(!section.text.includes('onebot_scan_code'), '指导段不该提已移除的扫描器');
    assert.ok(section.text.includes('onebot_code_scopes'), '要告诉 agent 去哪取位置');
    assert.equal(section.text.includes('不存在的目录'), false, '路径不进 prompt');
    assert.equal(section.text.includes('下游A'), false, '备注也不进 prompt');
    const altTool = altTools.find((t) => t.name === 'onebot_code_scopes');
    const got = JSON.parse(await altTool.execute({}));
    assert.equal(got.count, 2);
    assert.equal(got.scopes[0].exists, false, '不存在的路径如实报');
    assert.equal(got.scopes[0].kind, 'missing');
    assert.equal(got.scopes[1].exists, true);
    assert.equal(got.scopes[1].kind, 'dir');
    assert.equal(got.scopes[1].name, null, '没起名就报 null（不是编个空名字）');
  } finally {
    for (const { dispose } of alt.recorded.effects) dispose();
  }
});

check('resolveConfig 解析能力面配置（字符串数组 + 默认值）', () => {
  const cfg = resolveConfig({ capability: { writeAllow: '["send_like","set_group_card"]', exposeSensitive: true } });
  assert.deepEqual(cfg.capability.writeAllow, ['send_like', 'set_group_card']);
  assert.deepEqual(cfg.capability.dangerAllow, []);
  assert.equal(cfg.capability.exposeSensitive, true);
  assert.equal(cfg.capability.cache, true);
  assert.equal(cfg.capability.probe, true);
  assert.equal(cfg.capability.callTimeoutMs, 15000);
  // 缺省：写/危险全关、缓存与探测开。
  const bare = resolveConfig({});
  assert.deepEqual(bare.capability.writeAllow, []);
  assert.equal(bare.capability.exposeSensitive, false);
  // 坏 JSON 不该把插件炸掉，退回空名单。
  assert.deepEqual(resolveConfig({ capability: { writeAllow: 'not json' } }).capability.writeAllow, []);
});

check('下游接入端不再挂宿主 webServer：改由目标自己的地址监听', () => {
  // §19 改造：`ws-listen`/`http-api` 目标各自带 `host:port/path`，hub 真在那个端口上监听，
  // 所以不该再往宿主 `webServer.registerUpgrade` 里塞下游路由（那是老 `downstreamPath` 的路）。
  assert.equal(recorded.upgrades.length, 0, '不该再往宿主 webServer 注册下游 upgrade 路由');
  assert.equal(Config.dict.downstreamPath, undefined, 'downstreamPath 已删（并进目标地址）');
  assert.equal('downstreamPath' in resolveConfig({}), false, '解析后的配置里不该再有 downstreamPath');
});

check('浏览器自诊断通道：上报路由 + head 注入', () => {
  // 路由：精确路径、每条各一份（重复 (kind,path) 在真宿主会抛错，这里防回归）。
  // 两条：① 浏览器自诊断上报；② 设置页的模型清单（m024193）。
  assert.equal(recorded.routes.length, 2);
  assert.equal(recorded.routes[0].kind, 'exact');
  assert.equal(recorded.routes[0].path, CLIENT_PROBE_PATH);
  assert.equal(typeof recorded.routes[0].handler, 'function');
  const catalogRoute = recorded.routes.find((route) => route.path === MODEL_LIST_PATH);
  assert.ok(catalogRoute, `模型清单路由没注册：${MODEL_LIST_PATH}`);
  assert.equal(catalogRoute.kind, 'exact');
  assert.equal(typeof catalogRoute.handler, 'function');
  // 注入：监听 webserver/index-inject，往表里 push 一条 head 内的内联脚本。
  const injectEvent = recorded.onEvents.find((entry) => entry.name === 'webserver/index-inject');
  assert.ok(injectEvent, '应当监听 webserver/index-inject');
  const table = [];
  injectEvent.handler(table);
  assert.equal(table.length, 1);
  assert.equal(table[0].kind, 'script');
  assert.equal(table[0].placement, 'head');
  assert.ok(table[0].text.includes(CLIENT_PROBE_PATH), '探针脚本要上报到自己的路由');
  assert.ok(!table[0].text.includes('</script'), '内联脚本不能含 </script');
  // 同一份脚本被挂两个监听（根 ctx + webServer 注入 ctx）时不许注入两次。
  injectEvent.handler(table);
  const other = [];
  injectEvent.handler(other);
  assert.equal(table.length, 1, '同一张表里同一段脚本只注入一次');
  assert.equal(other.length, 1);
  // 收报：归一化 + 计数。
  const before = clientReportStatus().receivedItems;
  const result = noteClientReport({
    source: 'load-check',
    href: 'http://127.0.0.1:19387/?x=1',
    items: [{ kind: 'error', msg: 'boom', extra: 'stack' }, { kind: 'error', msg: 'boom2' }, 'nonsense', { kind: 'console.error', msg: 42 }],
  });
  assert.deepEqual(result, { ok: true, items: 3 });
  const status = clientReportStatus();
  assert.equal(status.receivedItems, before + 3);
  assert.equal(status.counts.error >= 2, true);
  assert.equal(status.counts['console.error'] >= 1, true);
  assert.equal(status.install.path, CLIENT_PROBE_PATH);
  assert.equal(status.recent.at(-1).items[0].kind, 'error');
  // 非对象负载：如实拒绝，不抛。
  assert.equal(noteClientReport(null).ok, false);
});

check('自诊断通道：宿主没有 webServer 时如实报不可用', () => {
  const outcome = installClientProbe({ get: () => undefined });
  assert.equal(outcome.available, false);
  assert.match(outcome.note, /没有 webServer/);
});

check('自诊断通道：webServer 缺 register 时不假装装上', () => {
  const outcome = installClientProbe({ webServer: { registerUpgrade() {} }, get: () => undefined });
  assert.equal(outcome.available, false);
  assert.match(outcome.note, /register/);
});

await checkAsync('模型清单路由（m024193）：有 llm 才真列，缺 llm 就如实降级', async () => {
  // 设置页在浏览器半侧，拿不到 `llm` 服务，所以清单只能靠这条只读路由送过去；
  // 拿不到时**不许报错**，退回手写文本框即可（页面自己会显示 note）。
  const providers = [{ id: 'prov-a', name: 'Provider A' }, { id: 'prov-b', name: 'Provider B' }];
  const models = {
    'prov-a': [
      { provider: 'prov-a', id: 'm-reason', name: 'M Reason' },
      { provider: 'prov-a', id: 'm-plain', name: 'M Plain' },
    ],
    'prov-b': [{ provider: 'prov-b', id: 'only-one', name: '只有它' }],
  };
  // `LlmResolvedModelInfo.reasoning = { efforts, defaultEffort }`——档位**嵌在 reasoning 里**，
  // `llm.listModels()` 给的 `LlmModelInfo` 压根没有这个字段，所以必须 resolve 一次。
  const efforts = {
    'prov-a/m-reason': { reasoning: { efforts: [{ id: 'low', name: '低' }, { id: 'high', name: '高' }], defaultEffort: 'low' } },
  };
  const fakeLlm = {
    listProviders: async () => providers,
    listModels: async (providerId) => models[providerId] || [],
    resolveModelInfo: async (provider, model) => efforts[`${provider}/${model}`] || {},
  };
  // llm 服务晚于本插件注入时要等它注册；这里已经在了，走同步分支。
  const ctx = {
    get: (key) => (key === 'webServer' ? { register: (route) => { registered.push(route); return () => {}; } } : key === 'llm' ? fakeLlm : undefined),
  };
  const registered = [];
  const outcome = installModelListRoute(ctx);
  assert.equal(outcome.available, true);
  assert.equal(outcome.path, MODEL_LIST_PATH);
  assert.equal(registered.length, 1);
  assert.equal(registered[0].kind, 'exact');
  assert.equal(registered[0].path, MODEL_LIST_PATH);
  assert.equal(typeof registered[0].handler, 'function');
  // GET 回 JSON：模型带 id/name；**档位不预取**（那是 N 次 resolveModelInfo），
  // 页面按当前选中的那个模型另发一次 `?provider=&model=` 去问。
  // 处理器是异步的（要等 llm），所以回执用 Promise 收。
  const call = (method, query = '') => new Promise((resolve) => {
    const out = { status: 0, headers: {} };
    const res = {
      writeHead: (status, headers) => { out.status = status; out.headers = headers || {}; },
      end: (text) => resolve({ ...out, raw: text, body: (() => { try { return JSON.parse(text); } catch { return null; } })() }),
    };
    registered[0].handler({ method, url: `${MODEL_LIST_PATH}${query}`, headers: {} }, res);
  });
  const sent = await call('GET');
  assert.equal(sent.status, 200);
  assert.match(sent.headers['content-type'], /application\/json/);
  const body = sent.body;
  assert.equal(body.ok, true);
  assert.deepEqual(body.providers.map((entry) => entry.id), ['prov-a', 'prov-b']);
  const flat = body.providers.flatMap((entry) => entry.models);
  assert.deepEqual(flat.map((entry) => entry.id).sort(), ['m-plain', 'm-reason', 'only-one']);
  assert.equal(body.efforts.length, 0, '不带参数不给档位');
  // 带 provider/model 才给档位，且只给**它自己声明的**那些。
  const withEfforts = (await call('GET', '?provider=prov-a&model=m-reason')).body;
  assert.equal(withEfforts.ok, true);
  assert.deepEqual(withEfforts.efforts, [{ id: 'low', name: '低' }, { id: 'high', name: '高' }]);
  assert.equal(withEfforts.defaultEffort, 'low');
  const withoutEfforts = (await call('GET', '?provider=prov-a&model=m-plain')).body;
  assert.deepEqual(withoutEfforts.efforts, [], '没声明 reasoning 的模型不该编出档位');
  assert.equal(withoutEfforts.ok, true, '没声明不是失败：页面据此退回文本框并说明原因');
  // POST/其它方法不许开写：这条路由只读。
  const posted = await call('POST');
  assert.equal(posted.status, 405);
  // 没有 webServer：available:false + note，不抛。
  const missing = installModelListRoute({ get: () => undefined });
  assert.equal(missing.available, false);
  assert.match(missing.note, /webServer/);
});

check('全局指导段注册在 systemPrompt.section', () => {
  assert.equal(hubSections().length, 1);
  assert.equal(hubSections()[0].name, 'plugin:dsh-onebot-hub');
  assert.equal(hubSections()[0].order, 160);
  assert.equal(typeof hubSections()[0].text, 'string');
});

check('三个 effect 都可释放', () => {
  assert.ok(recorded.effects.length >= 3, `effect 数 ${recorded.effects.length}`);
  for (const { label, dispose } of recorded.effects) {
    assert.equal(typeof dispose, 'function', `${label} 没有 disposer`);
  }
});

check('订阅 session/event：只把 hub 自己的会话记进账本', () => {
  const sub = recorded.onEvents.find((e) => e.name === 'session/event');
  assert.ok(sub, '没有订阅 session/event —— 真宿主里就叫不出回合的真实产出');
  sub.handler({ id: 'onebot-hub:group%3A55555' }, {
    type: 'assistant/message',
    seq: 1,
    time: Date.now(),
    data: { turn: 1, step: 1, message: { role: 'assistant', content: [{ type: 'text', text: '你好' }] }, stream: [] },
  });
  assert.equal(hub.mind.feedOf('group:55555')?.assistantText, '你好', 'hub 会话的事件没进账本');
  sub.handler({ id: 'session-7' }, {
    type: 'assistant/message',
    seq: 1,
    time: Date.now(),
    data: { turn: 1, step: 1, message: { role: 'assistant', content: [{ type: 'text', text: '别人的会话' }] }, stream: [] },
  });
  assert.equal(hub.mind.feedOf('session-7'), null, '非 hub 会话不该进账本');
});

check('agent 通道把宿主 API 接进了 pool.host', () => {
  assert.equal(typeof hub.pool.host.create, 'function');
  assert.equal(typeof hub.pool.host.resume, 'function');
  assert.equal(typeof hub.pool.host.createUserMessage, 'function');
  assert.equal(typeof hub.pool.host.hasSession, 'function');
});

check('onebot_hub_status 返回编排/记忆/隔离', () => {
  const tool = hubTools().find((t) => t.name === 'onebot_hub_status');
  assert.equal(typeof tool.execute, 'function');
});

check('onebot_timeline / onebot_reply 形状', () => {
  const timelineTool = hubTools().find((t) => t.name === 'onebot_timeline');
  const replyTool = hubTools().find((t) => t.name === 'onebot_reply');
  assert.ok(timelineTool.parameters.limit, '缺 limit 参数声明');
  assert.ok(replyTool.parameters.text, '缺 text 参数声明');
});

await checkAsync('onebot_reply（会话缓冲版）：新排队先把上一条立即发出，回执说实话（m06083）', async () => {
  const flushed = [];
  const tool = makeReplyTool(new ReplyBuffer(), { media: null, memes: { pathOf: () => null } }, () => {}, {
    deliverNow: async (candidate) => {
      flushed.push(candidate.text);
      return { status: 'ok', sentCount: 1, total: 1, failedAt: null };
    },
  });
  const desc = String(tool.description);
  assert.ok(desc.includes('允许多次调用'), '工具说明要写明一轮可以多次调用（m06083）');
  assert.ok(desc.includes('直接发出'), '工具说明要写明调用后会直接发出消息（m06083）');
  // 第一次调用：只排队。
  const r1 = await tool.execute({ text: '第一批' });
  assert.equal(flushed.length, 0, '第一次调用没有上一批，不该触发投递');
  assert.match(r1, /已排队回复/, `第一笔回执：${r1}`);
  // 第二次调用：先把上一批冲正发出，再排队本批。
  const r2 = await tool.execute({ text: '第二批' });
  assert.deepEqual(flushed, ['第一批'], '上一批要经 deliverNow 立即发出');
  assert.match(r2, /上一条回复已直接发出（1\/1 条）/, `冲正回执要说实话：${r2}`);
  assert.match(r2, /已排队回复/, `本批照常排队：${r2}`);
  // 失败路径：deliverNow 报 failed 时回执要带上第几条与 retcode。
  const failTool = makeReplyTool(new ReplyBuffer(), { media: null, memes: { pathOf: () => null } }, () => {}, {
    deliverNow: async () => ({ status: 'failed', sentCount: 0, total: 2, failedAt: 1, retcode: -1935986436 }),
  });
  await failTool.execute({ text: '甲' });
  const r4 = await failTool.execute({ text: '乙' });
  assert.match(r4, /发送失败（第 1\/2 条没发出去，retcode -1935986436）/, `失败回执要如实：${r4}`);
});

check('onebot_invoke 能在工具层指定说话人 user_id，并明说换账号可能换结果', () => {
  const invokeTool = hubTools().find((t) => t.name === 'onebot_invoke');
  assert.ok(invokeTool.parameters.user_id, '缺 user_id 参数声明');
  const desc = String(invokeTool.description);
  assert.ok(desc.includes('user_id'), '工具说明里没提 user_id');
  assert.ok(desc.includes('换 `user_id`') && desc.includes('换结果'), '工具说明没提醒"换账号就是换结果"');
  assert.ok(desc.includes('别拿默认账号的结果当成所有人的结果'), '工具说明没给出"要用目标账号再试一次"的用法');
  const uid = String(invokeTool.parameters.user_id.description ?? '');
  assert.ok(uid.includes('不写') && uid.includes('换账号就是换说话人'), 'user_id 参数说明不清楚');
});

check('onebot_invoke / onebot_relay_probe：注入只选**下游**，物理链路由枢纽决定（m02768）', () => {
  const invokeTool = hubTools().find((t) => t.name === 'onebot_invoke');
  assert.ok(invokeTool.parameters.downstream, 'onebot_invoke 缺 downstream（只有它才能真正"选下游"）');
  assert.ok(invokeTool.parameters.allow_real_link, 'onebot_invoke 缺 allow_real_link 逃生口');
  assert.ok(
    /mode=action/.test(String(invokeTool.parameters.linkId?.description ?? '')),
    'onebot_invoke 的 linkId 必须注明只对 mode=action 有意义（否则 agent 会拿它点物理链路）',
  );
  assert.ok(/由枢纽决定|枢纽按/.test(String(invokeTool.description)), '工具说明没写清"路由归枢纽"');
  const probeTool = hubTools().find((t) => t.name === 'onebot_relay_probe');
  assert.ok(probeTool.parameters.downstream, 'onebot_relay_probe 缺 downstream');
  assert.ok(probeTool.parameters.allow_real_link, 'onebot_relay_probe 缺 allow_real_link');
  assert.equal(probeTool.parameters.link, undefined, '旧的 link（点物理链路）应当去掉');
});

check('多下游记录带人话名字：hub 暴露 labelOf，指导段与工具说明都提到它', () => {
  assert.equal(typeof hub.labelOf, 'function', 'hub 没有 labelOf —— agent 分不出"这是哪个下游"');
  assert.equal(typeof hub.pickInjectLink, 'function', 'hub 没有 pickInjectLink —— 路由没归枢纽');
  const guided = hubSections().map((s) => String(s.text)).join('\n');
  assert.ok(/linkLabel|downstreamLabel/.test(guided), '指导段没告诉 agent 记录里带人话名字');
});

check('下游发出的媒体也会被解析：指导段说明"看到的是引用不是 base64"', () => {
  const guided = hubSections().map((s) => String(s.text)).join('\n');
  assert.ok(/mediaRefs/.test(guided) && /base64/.test(guided), '指导段没说明下游媒体会落地成引用');
});

check('onebot_media 取聊天记录：三个参数名都收，别让 agent 挨个试（真机试了 4 次）', () => {
  const mediaTool = hubTools().find((t) => t.name === 'onebot_media');
  for (const key of ['id', 'file', 'message_id']) {
    assert.ok(mediaTool.parameters[key], `onebot_media 缺 ${key}（实现端认的名字各家不同）`);
  }
  const desc = String(mediaTool.description);
  assert.ok(/get_forward_msg/.test(desc) && /60s|60 秒/.test(desc), '说明里要写清合并转发的默认超时（实测 30s 会 1200 超时）');
});

// ---- 异步项：真执行工具（走真 mind / store / timeline） ----
async function runAsyncChecks() {
  const toolOf = (n) => hubTools().find((t) => t.name === n);

  await checkAsync('唤醒一次 agent：setup 走通 installModelSelection（假 agentCtx）', async () => {
    const reply = { candidate: null, capture() { return null; }, take() { return null; }, clear() {} };
    await hub.pool.wake('group:55555', {
      text: '装载检查',
      summary: '装载检查',
      setup: (agentCtx) => hub.mind.setup(agentCtx, { reply, sessionKey: 'group:55555', agentKey: 'group:55555' }),
    });
    assert.equal(recorded.created.length + recorded.resumed.length, 1, 'pool 没有走宿主 create/resume');
    const input = recorded.created[0] ?? recorded.resumed[0];
    /**
     * 每次激活都是**新会话 id**（`onebot-hub:<key>.a<时间戳><随机>`）：旧写法用默认 id 并在
     * `sessionPersistence.list()` 里查到就 resume，重启后表空了 → 又把旧转录捡回来
     * （用户实测："重启以后新消息会被放到旧的会话里面"）。
     */
    assert.match(
      String(input.sessionId ?? input.resumeSessionId),
      /^onebot-hub:group%3A55555\.a[0-9a-z]+$/,
      `会话 id 应当是每次激活现生成的新 id：${input.sessionId ?? input.resumeSessionId}`,
    );
    assert.equal(recorded.resumed.length, 0, '不该 resume（旧转录不许再被读回）');
    assert.equal(typeof (input.setup ?? null), 'function', 'create 没带 setup');
    const info = hub.mind.stats.lastSetup;
    assert.equal(info?.sessionKey, 'group:55555', 'setup 没留痕');
    assert.equal(info.toolRegistered, true, '回复工具没注册成功');
    assert.equal(info.toolError, null);
    assert.equal(info.feedSubscribed, true, '会话作用域的 session/event 订阅没成功');
  });

  await checkAsync('会话按群名+时间命名，旧会话归档（用户定案）', async () => {
    // 命名：`create` 之后会用 `sessions.rename(sessionId, title)` 起个人话名字。
    await new Promise((resolve) => setTimeout(resolve, 20));
    const named = recorded.titles.at(-1);
    assert.ok(named, '没有调用 sessions.rename —— 会话列表里会是一串 onebot-hub:group%3A…');
    assert.match(String(named.sessionId), /^onebot-hub:group%3A55555\.a/, `改名的应当是本次激活的会话：${named.sessionId}`);
    assert.match(String(named.title), /群|私聊/, `标题要带人话的名字：${named.title}`);
    assert.match(String(named.title), /\d{4}-\d{2}-\d{2} \d{2}:\d{2}/, `标题要带时间：${named.title}`);
    // 归档：交还会话时调 `workspaceRegistry.archiveSession(id, { stopActivity: true })`。
    await hub.pool.host.retire('group:55555');
    const archived = recorded.archives.at(-1);
    assert.ok(archived, '没有调用 archiveSession —— 旧会话不会被归档');
    assert.equal(archived.sessionId, named.sessionId, '归档的应当是刚才那个会话');
    assert.equal(archived.stopActivity, true, '归档时要让宿主停掉它的活动（stopActivity）');
    assert.equal(hub.pool.host.lastRetire?.archived, true);
    assert.equal(hub.pool.host.lastTitle?.ok, true);
  });

  await checkAsync('会话归属（issue #1）：两个开关默认都不动，配了才挂工作区 / 才不归档', async () => {
    // 默认：不挂。上面那条已经验证过"结束照旧归档"。
    assert.equal(recorded.attaches.length, 0, '没配 agent.workspace 时不该去挂任何工作区');

    // ① agent.workspace：用它当会话 cwd，并把刚建的会话挂进该路径对应的已登记工作区。
    const wsCase = makeCtx();
    const wsPath = process.cwd();
    wsCase.recorded.workspaces.push({
      id: 'ws-1',
      path: wsPath,
      attachSession: async (sessionId) => {
        wsCase.recorded.attaches.push({ sessionId, workspaceId: 'ws-1' });
      },
    });
    const wsHub = apply(wsCase.ctx, {
      upstreamUrl: '',
      upstreamSelfId: '30001000',
      downstreamTargets: '[]',
      persist: false,
      agent: { mode: 'assist', batchMs: 500, workspace: wsPath },
    });
    await sleep(60);
    await wsHub.pool.wake('group:77777', { text: '装', summary: '装', setup: () => {} });
    await sleep(80);
    const createdWs = wsCase.recorded.created.at(-1);
    // cwd 必须是**规范化之后**的路径（issue #1 的坑）：宿主判定"会话属于哪个工作区"靠
    // header.cwd === 工作区的 canonical 路径，尾分隔符/盘符大小写/junction 差一点就还是「未分类」。
    const canon = (p) => (fs.realpathSync.native ? fs.realpathSync.native(p) : fs.realpathSync(p));
    assert.equal(createdWs?.meta?.cwd, canon(wsPath), 'agent.workspace 要当会话 cwd 用，且要规范化');
    const attached = wsCase.recorded.attaches.at(-1);
    assert.ok(attached, `配了 agent.workspace 就要把新会话挂进工作区；lastAttach=${JSON.stringify(wsHub.pool.host.lastAttach)}`);
    assert.equal(attached.sessionId, createdWs.sessionId, '挂的应当是刚建的那个会话 id');
    assert.equal(wsHub.pool.host.lastAttach?.ok, true, `attach 失败：${wsHub.pool.host.lastAttach?.error}`);

    // ①-b 尾分隔符/大小写不同也算同一个目录（否则用户手滑写个 `D:\x\` 就白配了）。
    const slashCase = makeCtx();
    slashCase.recorded.workspaces.push({
      id: 'ws-2',
      path: wsPath,
      attachSession: async (sessionId) => slashCase.recorded.attaches.push({ sessionId, workspaceId: 'ws-2' }),
    });
    const slashHub = apply(slashCase.ctx, {
      upstreamUrl: '',
      upstreamSelfId: '30001000',
      downstreamTargets: '[]',
      persist: false,
      agent: { mode: 'assist', batchMs: 500, workspace: `${wsPath}${path.sep}` },
    });
    await sleep(60);
    await slashHub.pool.wake('group:77778', { text: '装', summary: '装', setup: () => {} });
    await sleep(80);
    assert.ok(slashCase.recorded.attaches.at(-1), '带尾分隔符的路径也应当挂上');
    assert.equal(slashHub.pool.host.lastAttach?.ok, true);

    // ①-c 路径不存在：**不硬失败**（不能因为一个笔误让整台 hub 醒不过来），退回进程 cwd 且不 attach。
    const badCase = makeCtx();
    const badHub = apply(badCase.ctx, {
      upstreamUrl: '',
      upstreamSelfId: '30001000',
      downstreamTargets: '[]',
      persist: false,
      agent: { mode: 'assist', batchMs: 500, workspace: path.join(os.tmpdir(), 'onebot-hub-no-such-dir-xyz') },
    });
    await sleep(60);
    await badHub.pool.wake('group:77779', { text: '装', summary: '装', setup: () => {} });
    await sleep(80);
    const createdBad = badCase.recorded.created.at(-1);
    assert.ok(createdBad, '路径配错了也要照常建会话（退回进程 cwd）');
    assert.equal(createdBad.meta.cwd, process.cwd(), '路径用不了就退回进程 cwd');
    assert.equal(badCase.recorded.attaches.length, 0, '路径用不了时不挂（挂到进程 cwd 上更错）');
    assert.equal(badHub.pool.host.lastAttach?.ok, false);
    assert.match(String(badHub.pool.host.lastAttach?.error ?? ''), /agent\.workspace 用不了/, '失败原因要说得出来');

    // ② agent.archiveOnRetire=false：结束不归档，也**不能**退化成"删除会话"。
    const keepCase = makeCtx();
    const keepHub = apply(keepCase.ctx, {
      upstreamUrl: '',
      upstreamSelfId: '30001000',
      downstreamTargets: '[]',
      persist: false,
      agent: { mode: 'assist', batchMs: 500, archiveOnRetire: false },
    });
    await sleep(60);
    await keepHub.pool.wake('group:88888', { text: '装', summary: '装', setup: () => {} });
    const kept = await keepHub.pool.host.retire('group:88888');
    assert.equal(kept.archived, false, '关掉后不该归档');
    assert.equal(kept.via, 'archiveOnRetire:false');
    assert.equal(keepCase.recorded.archives.length, 0, '关掉后不该调用 archiveSession');
  });

  await checkAsync('易变上下文走会话级 live section（text 是函数，装配时现算），不再塞进用户消息', async () => {
    const specs = recorded.contexts ?? [];
    const live = specs.find((s) => s.name === 'onebot-hub:context');
    assert.ok(live, '缺 onebot-hub:context —— 卡片/记忆/窗口会退回"每轮塞进用户消息"的老路');
    assert.equal(typeof live.text, 'function', 'text 必须是函数（宿主每次装配现算），否则上下文会冻结在建立那一刻');
    assert.equal(typeof live.text(), 'string', 'live 上下文要能给出文本');
    const replySpec = specs.find((s) => s.name === 'onebot-hub:reply');
    assert.ok(replySpec && typeof replySpec.text === 'string', '回复指令那条还是静态字符串（它不随轮次变化）');
    // m30383 之后"文本=发言"默认关着，这条指令就不能再教模型"你写的回复会直接发出去"——
    // 它与 guidance/工具说明/mind 的 guidance 段三处相反，模型会据此以为不调工具也算说话（m34646 顺带修）。
    assert.ok(
      !replySpec.text.includes('会直接发到聊天里'),
      `speakAssistantText 默认关，却还在教"文本直接发言"：${replySpec.text.slice(0, 80)}`,
    );
    assert.ok(replySpec.text.includes('onebot_reply'), '要说清发言只有 onebot_reply 这一个出口');
    // 多次调用语义（m06083 定案 A）：新调用会把上一批立即发出去。这句在 guidance 段里
    // 曾经一直写着旧语义"只有最后一次会发出去"——它等于告诉模型"前几批会蒸发"，
    // 14:22 真机事故（分批发长报告，模型以为说完了就沉默）就是这句造成的。锁住两侧。
    assert.ok(
      !DEFAULT_GUIDANCE.includes('只有最后一次'),
      `guidance 里还留着"只有最后一次会发出去"的旧覆盖语义：${DEFAULT_GUIDANCE.match(/^.*只有最后一次.*$/m)?.[0] ?? ''}`,
    );
    assert.ok(
      /多调一次|多次调用的内容都会按顺序到达/.test(DEFAULT_GUIDANCE),
      'guidance 要写清"多调几次，前几批都会按顺序到达"，否则模型不敢分批发',
    );
    // 回复决策清单（参考 aigf-master）：提示词里必须有成体系的"什么不回"判断面，
    // 不能只剩三条散落的窄规则——这是模型判断"该不该开口"的主要依据。
    assert.ok(replySpec.text.includes('要不要回'), '回复提示词缺"要不要回"的决策清单入口');
    assert.ok(
      replySpec.text.includes('合并转发') && replySpec.text.includes('系统通知'),
      '占位消息与系统通知的"不回"判断要写进回复提示词',
    );
    assert.ok(
      replySpec.text.includes('不确定是不是在和你说话') && replySpec.text.includes('别硬续'),
      '"不确定就不回"与"群友不感兴趣别硬续"要写进回复提示词',
    );
    assert.ok(replySpec.text.includes('下游 bot 已经应答过'), '"下游已应答"这条硬规矩也要在回复提示词里');
    assert.equal(typeof hub.pool.retire, 'function', 'pool 缺 retire —— 激活结束交还会话就做不到');
  });

  await checkAsync('自建 agent 会加入 Agent 预设：meta.agentPreset + setup 里 mount，而不是「聚了人却不进预设」', async () => {
    const input = recorded.created[0] ?? recorded.resumed[0];
    // 默认预设现在是内置精简预设（m04972 定案①）：会话头 meta 必须带它，mount 也要挂它。
    assert.equal(input.meta?.agentPreset, 'onebot-hub-slim', 'create 没把预设写进会话头 meta（宿主不变量会拒掉它喊模型）');
    const mounted = recorded.presetMounts.at(-1);
    assert.ok(mounted, 'setup 回调里没有 mount Agent 预设');
    assert.equal(mounted.id, input.meta.agentPreset, 'mount 没带预设 id（该用 resolve 出来的那个）');
  });

  await checkAsync('旧会话写句柄被占且领养不到时，另起一个会话 id 兜底（不许静默不回话）', async () => {
    recorded.resumeError = 'session "onebot-hub:private%3A10001" is already owned by an active write handle';
    const before = recorded.created.length;
    const handle = await hub.pool.host.resume({ agentKey: 'private:10001', setup: () => {} });
    const created = recorded.created[before];
    assert.ok(created, '没有另起会话——这一轮就静默失败了');
    assert.match(String(created.sessionId), /^onebot-hub:private%3A10001\.r/, `另起的会话 id 不对：${created.sessionId}`);
    assert.equal(handle.id, created.sessionId);
    // 别把别的错误也一起吞了：只有"写句柄被占"才走兜底。
    recorded.resumeError = 'boom: 别的错误';
    await assert.rejects(() => hub.pool.host.resume({ agentKey: 'private:10001', setup: () => {} }), /boom/);
    recorded.resumeError = null;
  });

  await checkAsync('会话作用域的 session/event 订阅把产出记进账本，且按 seq 去重', async () => {
    const handler = recorded.agentEvents.find((e) => e.name === 'session/event')?.handler;
    assert.ok(handler, 'setup 里没有订阅 session/event');
    const event = {
      type: 'assistant/message',
      seq: 42,
      time: Date.now(),
      data: { turn: 1, step: 1, message: { role: 'assistant', content: [{ type: 'text', text: '一句话' }] }, stream: [] },
    };
    handler({ id: 'onebot-hub:group%3A55555' }, event);
    handler({ id: 'onebot-hub:group%3A55555' }, event); // root 级那条也会收到同一事件
    const text = hub.mind.feedOf('group:55555')?.assistantText ?? '';
    assert.equal(text.split('一句话').length - 1, 1, `重复投递被记了两遍：${text}`);
  });

  await checkAsync('回复工具注册失败会留痕，而不是静默伪装成"模型选择沉默"', async () => {
    const reply = { candidate: null, capture() { return null; }, take() { return null; }, clear() {} };
    // 故意给一个没有 tools 的 agentCtx：真宿主一旦这样，模型就没有任何出口，只能写普通文本。
    hub.mind.setup(
      { systemPrompt: { context: () => () => {} } },
      { reply, sessionKey: 'private:945126014', agentKey: 'private:945126014' },
    );
    const info = hub.mind.stats.lastSetup;
    assert.equal(info.sessionKey, 'private:945126014');
    assert.equal(info.hasToolsApi, false);
    assert.equal(info.toolRegistered, false);
    assert.match(String(info.toolError), /register/);
    assert.equal(info.hasPromptApi, true);
    assert.equal(info.feedSubscribed, false, 'agentCtx 没有 on 时必须记 false，而不是假装订阅成功');
  });

  await checkAsync('onebot_hub_status 能执行', async () => {
    const value = JSON.parse(await toolOf('onebot_hub_status').execute({}));
    assert.ok(value.policy !== undefined, '缺 policy');
    assert.ok(Array.isArray(value.downstream), '缺 downstream');
    assert.match(String(value.isolation), /scoped/, 'isolation 描述串缺级别');
    assert.equal(typeof value.memory.total, 'number');
    assert.equal(typeof value.agents.observed, 'number');
    assert.match(String(value.agentPolicy), /模式 /, 'sleep/awake 策略要报出来');
  });

  await checkAsync('会话级模型选择已装配：hub.models 存得住，/model 与 /vmodel 挂得上', async () => {
    // 识图默认模型由 hub 配置决定（m024167）：默认配置下 `agent.defaultVisionModel` 为空，
    // 模块默认就是系统默认模型；会话级覆盖由 `hub.models`（SessionModels）+ 命令面提供。
    assert.equal(typeof hub.models?.set, 'function', 'hub.models 没装配');
    assert.equal(hub.vision.provider, '', '识图模型的模块默认必须是空（系统默认模型）');
    assert.equal(hub.vision.model, '');
    hub.models.set('group:55555', 'vision', { provider: 'p', model: 'm' });
    assert.deepEqual(hub.models.visionFor('group:55555'), { provider: 'p', model: 'm' });
    assert.equal(hub.models.visionFor('group:66666'), null, '别的会话不该受影响');
    hub.models.set('group:55555', 'vision', null);
    const names = (hub.chatCommands?.describe?.().commands ?? []).concat(COMMAND_SPECS.map((spec) => spec.name));
    assert.ok(names.includes('model') && names.includes('vmodel'), `命令表里没有 /model 或 /vmodel：${names.join(',')}`);
  });

  await checkAsync('/perm 改到的是本次激活那个会话（m33779 真机 bug），且权限只对这一次激活有效', async () => {
    // 真机 bug：`.perm` 找的是**无后缀** id，而真正在跑的会话每次激活都带 `.a<时间戳><随机>`
    //（`964ddcf`），于是 `sessions.get()` 永远查不到 → 命令只会回"找不到它，改不了权限"。
    // 这里把宿主的会话库做成"只认带后缀的 id"，谁去问无后缀 id 一律 null——修好之后还能成功，
    // 就说明它要的根本不是那个 id。
    const permCalls = [];
    const asked = [];
    const sessionsSvc = {
      get: (id) => {
        asked.push(String(id));
        return String(id).includes('.a') ? { id } : null;
      },
      rename: async () => ({ ok: true, value: { title: 'x', seq: 1 } }),
    };
    const presetsSvc = {
      catalog: () => ({
        options: [
          { value: 'read-only', label: '只读' },
          { value: 'workspace-write', label: '工作区写入' },
        ],
      }),
      set: (session, value) => permCalls.push({ id: String(session?.id ?? ''), value: String(value) }),
      current: (session) => permCalls.filter((row) => row.id === String(session?.id ?? '')).at(-1)?.value ?? 'read-only',
    };
    const permCtx = makeCtx({ permissionPresets: presetsSvc, sessions: sessionsSvc });
    const permHub = apply(permCtx.ctx, {
      upstreamUrl: '',
      upstreamSelfId: '30001000',
      downstreamTargets: '[]',
      persist: false,
      chatCommands: { superUsers: '["10001"]' },
    });
    await sleep(60);
    assert.ok(permHub.chatCommands, '配了超管就该挂上命令处理器');
    const key = 'group:88991';
    const evt = (text) => ({ post_type: 'message', user_id: 10001, message: [{ type: 'text', data: { text } }] });
    // 先唤醒一次 = 有个"活着的会话"，id 必须是带后缀那个。
    const reply = { candidate: null, capture() { return null; }, take() { return null; }, clear() {} };
    await permHub.pool.wake(key, {
      text: '装载检查',
      summary: '装载检查',
      setup: (agentCtx) => permHub.mind.setup(agentCtx, { reply, sessionKey: key, agentKey: key }),
    });
    const liveId = String(permCtx.recorded.created.at(-1)?.sessionId ?? '');
    assert.match(liveId, /^onebot-hub:group%3A88991\.a[0-9a-z]+$/, `应当是本次激活的新会话 id：${liveId}`);

    const ask = await permHub.chatCommands.handle({ event: evt('/perm'), sessionKey: key });
    assert.equal(ask.handled, true);
    assert.equal(ask.reason, 'ok', `查询不该失败：${ask.reply}`);
    assert.match(ask.reply, /read-only/, '要报得出当前预设');
    assert.match(ask.reply, /只对/, '必须把"权限只对这一次激活有效"说出来，否则用户以为改了就一直有效');

    const set = await permHub.chatCommands.handle({ event: evt('/perm workspace-write'), sessionKey: key });
    assert.equal(set.handled, true);
    assert.equal(set.reason, 'ok', `设置不该失败：${set.reply}`);
    assert.match(set.reply, /workspace-write/);
    assert.match(set.reply, /只对这一次激活有效/, '回话要说清不持久');
    assert.equal(permCalls.length, 1, '应当只调了一次 presets.set');
    assert.equal(permCalls[0].id, liveId, `.perm 必须改到本次激活的会话，实际改到了 ${permCalls[0].id}`);
    assert.equal(permCalls[0].value, 'workspace-write');
    assert.ok(asked.length > 0, '没有去问 sessions.get');
    assert.equal(
      asked.includes('onebot-hub:group%3A88991'),
      false,
      '不该再去问那个无后缀的 id（真机 bug 的根）',
    );

    // 没被唤醒过的会话：`ensureAgent` 建起来后同样要改得到（超管常先给权限再让它干活）。
    const cold = await permHub.chatCommands.handle({ event: evt('/perm workspace-write'), sessionKey: 'group:88992' });
    assert.equal(cold.reason, 'ok', `没唤醒过的会话也要改得到：${cold.reply}`);
    assert.equal(permCalls.length, 2);
    assert.match(permCalls[1].id, /^onebot-hub:group%3A88992\.a/, `冷会话也该是带后缀的 id：${permCalls[1].id}`);

    // 预设名不在部署里：不改，把可选项列出来。
    const bad = await permHub.chatCommands.handle({ event: evt('/perm nope'), sessionKey: key });
    assert.match(bad.reply, /没有「nope」/);
    assert.equal(permCalls.length, 2, '认不出的预设名不许瞎设');
  });

  await checkAsync('onebot_timeline 能执行', async () => {
    const value = JSON.parse(await toolOf('onebot_timeline').execute({ limit: 5 }));
    assert.ok(value !== undefined && value !== null);
  });

  await checkAsync('onebot_context 能装配空会话', async () => {
    const value = JSON.parse(await toolOf('onebot_context').execute({ sessionKey: 'group:55555', text: false }));
    assert.equal(value.sessionKey, 'group:55555');
    assert.ok(Array.isArray(value.sections));
    assert.ok(value.sections.length > 0);
  });

  await checkAsync('onebot_memory_audit 能执行', async () => {
    const value = JSON.parse(await toolOf('onebot_memory_audit').execute({ limit: 5 }));
    assert.equal(typeof value, 'object');
  });

  await checkAsync('onebot_reply 空内容被拒', async () => {
    await assert.rejects(() => toolOf('onebot_reply').execute({ text: '' }), /需要 text、parts、images 或 memes/);
  });

  await checkAsync('onebot_call 缺 action 时报错可读', async () => {
    await assert.rejects(() => toolOf('onebot_call').execute({}), /需要 action/);
  });

  await checkAsync('onebot_caps 能执行：实现端/闸门/缓存/主动回忆账本在同一份快照里', async () => {
    const value = JSON.parse(await toolOf('onebot_caps').execute({}));
    assert.ok(Array.isArray(value.supported));
    assert.ok(Array.isArray(value.unsupported));
    assert.equal(typeof value.gates, 'object');
    assert.equal(typeof value.cache.hits, 'number');
    assert.equal(value.reminders.windowHours, 24, 'M18 的防骚扰窗口默认 24 小时');
    assert.equal(value.media.enabled, true, 'M14 的媒体落地默认开着');
    assert.equal(value.media.cached, 0);
    assert.equal(value.media.attachments, false, '没接宿主 attachments 时如实说没有');
    assert.equal(value.learn.enabled, true, 'M7 的用法学习默认开着');
    assert.equal(value.learn.threshold, 3);
    assert.equal(value.learn.total, 0);
    assert.match(value.note, /unknown/);
  });

  await checkAsync('onebot_media：两种用法分得清（落地 vs 问实现端），落地模式说得出为什么没落', async () => {
    const t = toolOf('onebot_media');
    // ① 落地模式：list 给统计；本用例没开存储（persist:false），所以 blob 目录不存在、但功能照旧可用
    const listed = JSON.parse(await t.execute({ list: true }));
    assert.equal(listed.stats.enabled, true);
    assert.equal(typeof listed.stats.maxBytes, 'number');
    assert.deepEqual(listed.items, []);

    // ② 落地说不清来源时不许假装成功
    const unknown = JSON.parse(await t.execute({ messageId: '999999' }));
    assert.match(String(unknown.error), /段不在手边/);

    // ③ 直接给字节：不依赖上游，也该落地（这里 storage 关着，所以 blob 为空但 ref 有 sha256）
    const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==';
    const direct = JSON.parse(await t.execute({ link: `base64://${png}`, type: 'image', name: '一点图' }));
    assert.equal(direct.refs.length, 1);
    assert.equal(direct.refs[0].mediaType, 'image/png');
    assert.match(direct.refs[0].sha256, /^[0-9a-f]{64}$/);

    // ④ 问实现端这条老路还在（action 模式）：假上游没连，必须回一句人话而不是抛
    const asked = JSON.parse(await t.execute({ action: 'get_forward_msg', message_id: '1' }));
    assert.equal(asked.ok, false);
    assert.equal(typeof asked.note, 'string');
  });

  await checkAsync('onebot_reply（直发版）images：hub-media 引用发之前解析成 blob 本地路径（修1，真机 failed -1935986436）', async () => {
    const originalMedia = hub.media;
    const originalUpstream = hub.upstream;
    const calls = [];
    try {
      // 换一个"媒体库"：find 一问就有 blob——真实例里这是 #resolveMedia 落地后的产物；
      // 再换一个"上游"：直发版会真的 request，正好拿它验收出站的段长什么样。
      hub.media = { find: (id) => (id === 'hub-media:abc123' ? { id, blob: 'D:\\fake\\blobs\\abc123.png', mediaType: 'image/png' } : null) };
      hub.upstream = {
        isConnected: true,
        request: async (action, params) => {
          calls.push({ action, params });
          return { status: 'ok', retcode: 0, data: null, echo: null };
        },
      };
      const t = hubDirectReply();
      // m32420 起「一次调用发多条」：文字一条 + 图各一条 = 2 次 send_msg。
      await t.execute({ text: '看这个', images: ['hub-media:abc123'], group_id: '55555' });
      const segs = calls.at(-1)?.params?.message ?? [];
      assert.equal(calls.length, 2, '文字一条、图一条');
      assert.match(calls[0]?.params?.message?.[0]?.data?.text ?? '', /^看这个$/, '第一条是那句文字');
      assert.equal(
        segs.some((s) => s.type === 'image' && s.data?.file === 'D:\\fake\\blobs\\abc123.png'),
        true,
        '发出去的必须是 blob 本地路径',
      );
      assert.equal(segs.some((s) => String(s.data?.file ?? '').startsWith('hub-media:')), false, 'hub-media 引用不能原样出站');
      // 对象形式：只换 file 字段，其余保留
      await t.execute({ text: '', images: [{ file: 'hub-media:abc123', summary: '说明' }], group_id: '55555' });
      assert.equal(calls.length, 3, '纯图只发一条');
      // 修1 的否命题：失效引用当场报错——不能排队一条/发出一条注定 failed 的消息
      await assert.rejects(
        () => t.execute({ text: 'x', images: ['hub-media:deadbeef'], group_id: '55555' }),
        /图片引用不可用：hub-media:deadbeef/,
      );
      assert.equal(calls.length, 3, '报错的这一次不能真的发出去');
    } finally {
      hub.media = originalMedia;
      hub.upstream = originalUpstream;
    }
  });

  await checkAsync('onebot_media 落地模式在消息里的段找不到时不编造，段数组也从不被改写', async () => {
    const segs = [
      { type: 'text', data: { text: '看图' } },
      // 内联字节，别让测试去碰网络；这里只关心"段数组不被改写"
      { type: 'image', data: { file: 'base64://iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==' } },
    ];
    const before = JSON.stringify(segs);
    hub.handleUpstreamEvent({
      post_type: 'message',
      message_type: 'group',
      self_id: '30001000',
      message_id: 4242,
      group_id: 55555,
      user_id: 10001,
      sender: { user_id: 10001, nickname: '小明', role: 'member', card: '' },
      message: segs,
    });
    // 中间事件构造后段数组本身不该被任何人改
    assert.equal(JSON.stringify(segs), before, '时间线/落地都不许改段数组');
    const entry = hub.timeline.bySession('group:55555').find((e) => e.refs?.message_id === 4242);
    assert.match(entry.text, /\[图片\]/, '没有 ref 时就给占位，不编造"已存为"');
    const r = JSON.parse(await toolOf('onebot_media').execute({ messageId: '4242' }));
    assert.ok(Array.isArray(r.refs));
  });

  await checkAsync('onebot_media：link 落地也走 describe:true（之前只有按消息 id 那条路会看图）', async () => {
    const png = path.join(os.tmpdir(), `hub-ig-describe-${Date.now()}.png`);
    fs.writeFileSync(png, Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c6300010000050001', 'hex'));
    const savedVision = hub.vision;
    hub.vision = { describeEnabled: true, describeImage: async ({ mediaType }) => ({ text: `假描述（${mediaType}）` }) };
    try {
      const r = JSON.parse(await toolOf('onebot_media').execute({ link: png, type: 'image', describe: true }));
      assert.equal(r.refs?.length, 1, '图应落成 ref');
      assert.match(r.refs[0].mediaType, /^image\/png$/, 'PNG 魔数要被嗅探出来');
      assert.match(r.refs[0].text ?? '', /假描述（image\/png）/, 'link 落地的图也要有描述');
      assert.equal(r.descriptions?.length, 1, 'descriptions 里带回描述');
    } finally {
      hub.vision = savedVision;
      fs.rmSync(png, { force: true });
    }
  });

  await checkAsync('onebot_avatar 拼社区惯例 URL 并标 provenance', async () => {
    const user = JSON.parse(await toolOf('onebot_avatar').execute({ user_id: 945126014, size: 100 }));
    assert.equal(user.url, 'https://q1.qlogo.cn/g?b=qq&nk=945126014&s=100');
    assert.equal(user.provenance, 'community');
    const group = JSON.parse(await toolOf('onebot_avatar').execute({ group_id: 123456789 }));
    assert.equal(group.url, 'https://p.qlogo.cn/gh/123456789/123456789/100');
    assert.equal(group.provenance, 'impl-doc');
    await assert.rejects(() => toolOf('onebot_avatar').execute({}), /需要 user_id 或 group_id/);
  });

  await checkAsync('onebot_members 缺 group_id 时报错可读', async () => {
    await assert.rejects(() => toolOf('onebot_members').execute({}), /需要 group_id/);
  });

  await checkAsync('onebot_invoke 未给 linkId 时报错可读', async () => {
    await assert.rejects(
      () => toolOf('onebot_invoke').execute({ mode: 'action', action: 'get_status' }),
      /未找到下游链路/,
    );
  });

  await checkAsync('onebot_admin 预演不下发、缺参数与未知 op 报错可读', async () => {
    const dry = JSON.parse(await toolOf('onebot_admin').execute({ op: 'kick', params: { group_id: 55555, user_id: 10001 } }));
    assert.equal(dry.dryRun, true);
    assert.equal(dry.action, 'set_group_kick');
    assert.match(dry.willDo, /移出群 55555/);
    assert.equal(dry.gate.allowed, false, 'danger 级默认应被策略拦下');
    assert.equal(dry.gate.reason, 'danger');
    await assert.rejects(() => toolOf('onebot_admin').execute({ op: 'mute', params: { group_id: 55555 } }), /缺少必需参数：user_id、duration/);
    await assert.rejects(() => toolOf('onebot_admin').execute({ op: '不存在的动作' }), /未知管理动作/);
    await assert.rejects(() => toolOf('onebot_admin').execute({}), /onebot_admin 需要 op/);
  });

  await checkAsync('onebot_memory：写入落库、modify 优先于 add、可见性由代码判定', async () => {
    const t = toolOf('onebot_memory');
    const ctxArg = { sessionKey: 'group:55555', actorId: '10001' };

    // 活跃层（`m17909`）：短期记忆的职能搬到这里，写入只认当前会话。
    const r1 = JSON.parse(await t.execute({ ...ctxArg, ops: { active: { add: [{ kind: 'topic', text: '在讨论喝什么' }] } } }));
    assert.equal(r1.applied.active.add, 1, JSON.stringify(r1));
    assert.equal(hub.active.all().length, 1);
    const activeRec = hub.active.all()[0];
    assert.equal(activeRec.originScope, 'group:55555', '来源会话必须落盘，跨会话可见性靠它算');
    assert.equal(activeRec.status, 'open');

    // `short_term.add` 退役：不是静默忽略，而是明说"用 active"。
    const retired = JSON.parse(await t.execute({ ...ctxArg, ops: { short_term: { add: [{ text: '他喜欢喝美式' }] } } }));
    assert.equal(retired.applied.short_term.add, 0);
    assert.ok(retired.rejected.some((x) => /active/.test(x.reason) && /短期记忆已改为/.test(x.reason)), JSON.stringify(retired.rejected));

    // 模型自己声明可见性 → 记一条 rejection，但**仍按代码推断落盘**（硬边界，不是报错退出）。
    const r2 = JSON.parse(
      await t.execute({ ...ctxArg, ops: { long_term: { add: [{ text: '他今天心情不好', visibility: 'private', related_users: ['10001'] }] } } }),
    );
    assert.equal(r2.applied.long_term.add, 1, `R2 ${JSON.stringify(r2.applied)} / ${JSON.stringify(r2.rejected)}`);
    assert.ok(r2.rejected.some((x) => /visibility/.test(x.path) && x.reason.includes('由代码')), JSON.stringify(r2.rejected));
    const stored = hub.store.all().find((e) => e.text === '他今天心情不好');
    assert.equal(stored.visibility, 'group:55555', '模型给的 private 不该被采纳，代码按"点了名"收敛回本群');

    // 活跃层的 update 按"看得见的那份列表"的序号走；同批 add 不会让序号错位。
    const r3 = JSON.parse(
      await t.execute({ ...ctxArg, ops: { active: { update: [{ index: 0, text: '在讨论买哪款咖啡机' }], add: [{ kind: 'task', text: '正在整理型号对比' }] } } }),
    );
    assert.equal(r3.applied.active.update, 1, JSON.stringify(r3));
    assert.equal(r3.applied.active.add, 1);
    assert.ok(hub.active.all().some((e) => e.text === '在讨论买哪款咖啡机'));
    assert.ok(hub.active.all().some((e) => e.kind === 'task'));

    // 越界序号不静默：报"当前 N 条"让人照着改。
    const r4 = JSON.parse(await t.execute({ ...ctxArg, ops: { active: { update: [{ index: 99, text: 'x' }] } } }));
    assert.ok(r4.rejected.some((x) => /序号越界/.test(x.reason)));

    // 非法的 kind：拒掉**而且不落盘**（不能一边说"只认 topic/task"，一边按 topic 存进去）。
    const rBadKind = JSON.parse(await t.execute({ ...ctxArg, ops: { active: { add: [{ kind: 'note', text: '不合法的类目' }] } } }));
    assert.equal(rBadKind.applied.active.add, 0, JSON.stringify(rBadKind));
    assert.ok(rBadKind.rejected.some((x) => /只认/.test(x.reason)), JSON.stringify(rBadKind.rejected));
    assert.ok(!hub.active.all().some((e) => e.text === '不合法的类目'), '非法的 kind 不能落盘');

    // 活跃层只准写当前会话：模型不能替别的群开话题。
    const prevKey = hub.mind.activeSessionKey;
    hub.mind.activeSessionKey = 'group:55555';
    const rOther = JSON.parse(
      await t.execute({ sessionKey: 'group:66666', actorId: '10001', ops: { active: { add: [{ kind: 'topic', text: '替别的群开的' }] } } }),
    );
    hub.mind.activeSessionKey = prevKey;
    assert.equal(rOther.applied.active.add, 0, JSON.stringify(rOther));
    assert.ok(rOther.rejected.some((x) => /不能替别的会话写/.test(x.reason)), JSON.stringify(rOther.rejected));
    assert.ok(!hub.active.all().some((e) => e.text === '替别的群开的'), '不能替别的会话写活跃条目');

    // 结算（`m17909`）：keep 必须给 summary——那一行才是"以后还记得发生过这件事"的唯一证据；
    // 细节按 keep_as 落档案（这里落到话题归档）。结算完这条就从活跃层消失。
    const rk = JSON.parse(
      await t.execute({
        ...ctxArg,
        ops: {
          active: {
            settle: [
              { index: 0, outcome: 'keep', summary: '群里最后定了磨豆机买哪款', keep_as: { target: 'topic', title: '咖啡机选购', conclusion: '选了磨豆机 A' } },
            ],
          },
        },
      }),
    );
    assert.equal(rk.applied.active.settle.keep, 1, JSON.stringify(rk));
    const indexLine = hub.store.all().find((e) => e.text === '群里最后定了磨豆机买哪款');
    assert.ok(indexLine, 'keep 必须写一行长期记忆索引');
    assert.equal(indexLine.term, 'long');
    // 档案指针（`m20216`）：索引行只给一句话，模型得知道细节在哪儿。话题归档的 id 是模型给的
    // 标题（`咖啡机选购`），指针就指它——没有这一条，模型只记得"发生过"，查不到详情。
    assert.deepEqual(indexLine.archive, [{ target: 'topic', id: '咖啡机选购' }], JSON.stringify(indexLine));
    assert.ok(
      hub.mind.snapshot('group:55555', { actorId: '10001', audit: false }).blocks.longTerm.some((e) => Array.isArray(e.archive) && e.archive.length),
      '长期块里的条目要带着指针（渲染层靠它出〔详见 …〕）',
    );
    // 回执里也要带一份最新的长期记忆序号表（`m20216`）：长期块的号同样会漂，
    // 只回活跃层不够——模型照样会照着旧号 `long_term.modify`。
    assert.ok(Array.isArray(rk.long_term_list), '回执里要有长期记忆的最新序号表');
    assert.ok(rk.long_term_list.every((x, i) => x.index === i), '长期记忆序号也要连着编');
    assert.ok(
      rk.long_term_list.some((x) => x.text === '群里最后定了磨豆机买哪款'),
      '刚写进去的那一行要在表里',
    );
    assert.ok(!hub.active.all().some((e) => e.text === '在讨论买哪款咖啡机'), '结算后活跃层不留"已完成"条目');
    assert.equal(hub.profiles.topic('咖啡机选购').status, 'closed');
    // 回执带一份**最新序号**：结算掉一条，后面的号会前移，模型得知道现在几号对应哪一条。
    assert.ok(Array.isArray(rk.active?.list), '回执里要有最新序号表');
    assert.ok(rk.active.list.every((x, i) => x.index === i), '序号必须连着编');
    assert.ok(!rk.active.list.some((x) => x.text === '在讨论买哪款咖啡机'), '结算掉的不该还在表里');

    // drop 就是直接删，不留痕。
    const dropIdx = hub.mind.snapshot('group:55555', { actorId: '10001', audit: false }).active;
    const rd = JSON.parse(
      await t.execute({ ...ctxArg, ops: { active: { settle: [{ index: 0, outcome: 'drop' }] } } }),
    );
    assert.equal(rd.applied.active.settle.drop, 1, JSON.stringify(rd));
    assert.ok(!hub.active.all().some((e) => e.id === dropIdx.entries[0].id));

    // 人物档案：facts 与 corrections 分开落，`impression` 更新。
    const r5 = JSON.parse(
      await t.execute({
        ...ctxArg,
        ops: {
          persons: {
            10001: {
              facts: [{ text: '在写一个 QQ 机器人' }],
              corrections: [{ wrong: '以为他是学生', right: '他其实已经工作了' }],
              impression: '话不多，技术问题问得准',
            },
          },
        },
      }),
    );
    assert.equal(r5.applied.persons, 1);
    const person = hub.profiles.person('10001');
    assert.equal(person.facts.length, 1);
    assert.equal(person.corrections[0].right, '他其实已经工作了');
    assert.match(person.impression, /技术问题问得准/);

    // 群档案与话题：模型只能写"提炼"字段（群名/人数/群主是观测所得，不给模型改）。
    const r6 = JSON.parse(
      await t.execute({
        ...ctxArg,
        ops: {
          // `highlights` 在 `m17909` 删掉了：写它现在会被当成未知字段拒绝。
          groups: { 'group:55555': { culture: '爱聊硬件，不喜欢刷屏', memberCount: 999, highlights: [{ text: '上次抽奖取消了' }] } },
          topics: { '散热改装': { title: '散热改装', worldKeys: ['group:55555'], events: [{ text: '讨论到风扇型号' }] } },
        },
      }),
    );
    assert.equal(r6.applied.groups, 1);
    assert.equal(r6.applied.topics, 1);
    assert.ok(r6.rejected.some((x) => /memberCount/.test(x.path) && /未知字段/.test(x.reason)), JSON.stringify(r6.rejected));
    assert.ok(r6.rejected.some((x) => /highlights/.test(x.path) && /未知字段/.test(x.reason)), JSON.stringify(r6.rejected));
    const group = hub.profiles.group('group:55555');
    assert.match(group.culture, /爱聊硬件/);
    assert.equal(group.memberCount, null, '人数是观测字段，模型写不进来');
    assert.equal(group.highlights, undefined, 'highlights 已删除，不该再落盘');

    // 不是 JSON / 不是对象 → 给出可读回执，不抛。
    const bad = JSON.parse(await t.execute({ ...ctxArg, ops: '这不是 JSON' }));
    assert.equal(bad.applied.short_term.add, 0);
    assert.match(String(bad.note ?? bad.rejected[0]?.reason), /必须是对象/);

    // 同文本再写一次 `long_term`：它已经是长期了，直接说清楚（不再假装"提升成功"）。
    // 注：`short_term.add` 退役后，工具侧已经造不出"短期→长期"的提升场景；
    // `tryPromote` 那条路径留给历史残留条目（见 writer 的 `short_term` 说明）。
    const rp = JSON.parse(await t.execute({ ...ctxArg, ops: { long_term: { add: [{ text: '他今天心情不好' }] } } }));
    assert.equal(rp.blocks.long_term.promoted, 0);
    assert.ok(rp.rejected.some((x) => /已经是长期记忆/.test(x.reason)), JSON.stringify(rp.rejected));
    const promotedRec = hub.store.all().find((e) => e.text === '他今天心情不好');
    assert.equal(promotedRec.term, 'long');
  });

  await checkAsync('onebot_topic：单条读得到，列表按最近活动倒序', async () => {
    const one = JSON.parse(await toolOf('onebot_topic').execute({ id: '散热改装' }));
    assert.equal(one.title, '散热改装');
    assert.equal(one.status, 'open');
    assert.equal(one.events[0].text, '讨论到风扇型号');
    const list = JSON.parse(await toolOf('onebot_topic').execute({}));
    assert.ok(list.items.some((x) => x.id === '散热改装'));
    assert.equal(list.items.find((x) => x.id === '散热改装').events, 1);
    await assert.rejects(() => toolOf('onebot_topic').execute({ id: '没这个话题' }), /没有「没这个话题」这个话题/);
  });

  await checkAsync('onebot_person / onebot_sessions 读得到档案，且按隔离过滤', async () => {
    const person = JSON.parse(await toolOf('onebot_person').execute({ userId: '10001', sessionKey: 'group:55555' }));
    assert.equal(person.userId, '10001');
    assert.ok(Array.isArray(person.facts));
    assert.equal(person.denied, 0, '同群视角下自己写的事实应当可见');
    assert.deepEqual(person.corrections.map((c) => c.right), ['他其实已经工作了']);

    // 换个群看同一个人：`scoped` 级别下这一条事实不该出现（可见性由代码判定，不是模型声明）。
    const elsewhere = JSON.parse(await toolOf('onebot_person').execute({ userId: '10001', sessionKey: 'group:66666' }));
    assert.deepEqual(elsewhere.facts.map((f) => f.text), []);
    assert.equal(elsewhere.denied >= 1, true, '被挡下的条数必须报出来，而不是静默变空');

    const list = JSON.parse(await toolOf('onebot_sessions').execute({}));
    assert.ok(Array.isArray(list.items));
    assert.equal(typeof list.count, 'number');
    const unknown = JSON.parse(await toolOf('onebot_person').execute({ userId: '99999999', sessionKey: 'group:55555' }));
    assert.equal(unknown.empty, true, '没观测到的人应明确回 empty，而不是给一个空壳档案');
  });

  // `m15264`：长期记忆不该因为"进了长期库"就变成跨群可念的公共知识。
  // 以前 `long_term.add` 一律盖 shareable，A 群"小张下周离职"到 B 群照样原样说出来。
  await checkAsync('记忆的「讲的是谁」：写进去就带上、点名错了会说、跨群按成员表放行或拦截', async () => {
    const t = toolOf('onebot_memory');
    const ctxArg = { sessionKey: 'group:55555', actorId: '10002' };

    // ① 模型点名了"这条讲的是谁" → 落盘带上 relatedUsers，且**不再是** shareable。
    const r = JSON.parse(
      await t.execute({ ...ctxArg, ops: { long_term: { add: [{ text: '小张下周离职', related_users: ['10002'] }] } } }),
    );
    assert.equal(r.applied.long_term.add, 1, JSON.stringify(r));
    const rec = hub.store.all().find((e) => e.text === '小张下周离职');
    assert.deepEqual(rec.relatedUsers, ['10002'], 'related_users 必须落盘，读取侧才拦得住');
    assert.notEqual(rec.visibility, 'shareable', '点了名的记忆不能是 shareable');

    // ② 写了名字而不是 QQ 号 → 照落盘，但要说出来（不静默）：模型得知道 QQ 号才拦得住。
    const rn = JSON.parse(
      await t.execute({ ...ctxArg, ops: { long_term: { add: [{ text: '老王会修车', related_users: ['老王'] }] } } }),
    );
    assert.ok(
      rn.rejected.some((x) => /related_users/.test(x.path) && /QQ 号/.test(x.reason)),
      JSON.stringify(rn.rejected),
    );
    assert.equal(hub.store.all().find((e) => e.text === '老王会修车').relatedUsers, null);

    // ③ 人物档案的 fact 自动等于"讲的是这个人"，不用模型点名（档案本身就是按人存的）。
    const rf = JSON.parse(
      await t.execute({ ...ctxArg, ops: { persons: { 10003: { facts: [{ text: '他养了三只猫' }] } } } }),
    );
    assert.equal(rf.applied.persons, 1, JSON.stringify(rf));
    const pFact = hub.profiles.person('10003').facts.find((f) => f.text === '他养了三只猫');
    assert.deepEqual(pFact.relatedUsers, ['10003']);
    assert.notEqual(pFact.visibility, 'shareable');

    // ---- 读取侧：闸门本体（用 open 级别，才能看清"点名的人"这一层自己放不放行）----
    const open = resolveIsolation({ level: 'open', crossGroupFacts: 'all', crossGroupIdentity: true });
    const named = { id: 'e1', kind: 'fact', scope: 'group:55555', visibility: 'group:55555', text: '小张下周离职', relatedUsers: ['10002'] };
    const plain = { id: 'e2', kind: 'fact', scope: 'group:55555', visibility: 'shareable', text: '这个群爱聊硬件' };

    setGroupMembershipProvider(null);
    assert.equal(
      filterForScope([named, plain], { sessionKey: 'group:66666', isolation: open }).visible.map((e) => e.id).join(','),
      'e2',
      '没有成员表时：有名字的拦掉、没名字的照旧放行',
    );
    assert.equal(filterForScope([named], { sessionKey: 'group:55555', isolation: open }).visible.length, 1, '同群不受这条闸门影响');

    const withMembers = (ids) => setGroupMembershipProvider((gid) => (gid === 'group:66666' ? { ids: new Set(ids), complete: true, at: Date.now() } : null));
    withMembers(['10002', '10001']);
    assert.equal(filterForScope([named], { sessionKey: 'group:66666', isolation: open }).visible.length, 1, '这些人都在这个群里 → 放行');
    withMembers(['10001']);
    assert.equal(filterForScope([named], { sessionKey: 'group:66666', isolation: open }).visible.length, 0, '人不在这个群 → 拦');

    // 不完整的成员表不能当"人不在"的证据，但也别当成"人在"：一律拦。
    setGroupMembershipProvider((gid) => (gid === 'group:66666' ? { ids: new Set(['10002']), complete: false, at: Date.now() } : null));
    assert.equal(filterForScope([named], { sessionKey: 'group:66666', isolation: open }).visible.length, 0, '表不完整 → 拦');

    // ---- 群档案里的成员表本身 ----
    const now = hub.profiles.now();
    hub.profiles.noteGroupMembers('group:77777', ['1', '2', '3'], { at: now });
    assert.equal(hub.profiles.inGroupMembers('group:77777', '2'), true);
    assert.equal(hub.profiles.inGroupMembers('group:77777', '9'), false);
    assert.equal(
      hub.profiles.groupMembers('group:77777', { now: now + 8 * 24 * 60 * 60 * 1000 }),
      null,
      '成员表过期后按"查不到"处理，不能一直当证据用',
    );
    hub.profiles.markGroupMembersStale('group:77777', now);
    assert.equal(hub.profiles.inGroupMembers('group:77777', '2'), null, '失效的表 → 查不到（三态里的 null，不是 false）');

    // 写侧单测：点名的长期记忆一定不是 shareable。
    assert.equal(inferWriteVisibility({ block: 'long_term', scope: 'group:55555', sessionKey: 'group:55555', text: 'x' }), 'shareable');
    assert.notEqual(
      inferWriteVisibility({ block: 'long_term', scope: 'group:55555', sessionKey: 'group:55555', text: 'x', relatedUsers: ['10002'] }),
      'shareable',
    );
    assert.equal(
      inferWriteVisibility({ block: 'long_term', scope: 'private:10002', sessionKey: 'private:10002', text: 'x', relatedUsers: ['10002'] }),
      'private',
      '私聊来源仍然一票 private',
    );

    // 复原成插件自己装的那个 provider，别把后面的用例带偏。
    setGroupMembershipProvider((gid) => hub.profiles?.groupMembers?.(gid) ?? null);
  });

  await checkAsync('跨群事实 shareable 档：点了名且人都在本群的可跨群，没点名的照旧拦（m16688）', async () => {
    // 用户要的语义：`crossGroupFacts: shareable` 不只是"shareable 条目"，还包含
    // "点了名、且点的人此刻都在本群"的群内事实——按人放行，人一散自动收回。
    const iso = resolveIsolation({ level: 'balanced', crossGroupFacts: 'shareable' });
    const ctx = { sessionKey: 'group:66666', isolation: iso };
    const named = { id: 'n1', kind: 'fact', scope: 'group:55555', visibility: 'group:55555', text: '小张下周离职', relatedUsers: ['10002'] };
    const plain = { id: 'n2', kind: 'fact', scope: 'group:55555', visibility: 'group:55555', text: '这个群爱聊硬件' };
    const members = (ids, complete = true) =>
      setGroupMembershipProvider((gid) => (gid === 'group:66666' ? { ids: new Set(ids), complete, at: Date.now() } : null));

    members(['10002']);
    const r1 = filterForScope([named, plain], ctx);
    assert.equal(r1.visible.map((e) => e.id).join(','), 'n1', '点名且人在本群 → 放行；没点名的不能搭便车');
    assert.match(String(r1.audit[0]?.reason), /shareable\|relatedUsers:in-group/, String(r1.audit[0]?.reason));

    members(['10001']);
    assert.equal(filterForScope([named], ctx).visible.length, 0, '人不在这个群 → 拦');
    members(['10002'], false);
    assert.equal(filterForScope([named], ctx).visible.length, 0, '成员表不完整 → 拦（fail-closed，不拿半张表当证据）');

    // never 档：点名也不放（用户明确关掉跨群时，别偷偷按人放行）。
    const never = resolveIsolation({ level: 'balanced', crossGroupFacts: 'never' });
    members(['10002']);
    assert.equal(filterForScope([named], { sessionKey: 'group:66666', isolation: never }).visible.length, 0, 'never 档点名也不放');

    // all 档语义不变：连没点名的群内事实也跨。
    const all = resolveIsolation({ level: 'balanced', crossGroupFacts: 'all' });
    assert.equal(filterForScope([plain], { sessionKey: 'group:66666', isolation: all }).visible.length, 1, 'all 档照旧全放');

    // 敏感闸在配置之前：点了名也照样拦。
    members(['10002']);
    assert.equal(
      filterForScope([{ ...named, id: 'n3', sensitive: true }], ctx).visible.length,
      0,
      '敏感条目不看档位',
    );

    setGroupMembershipProvider((gid) => hub.profiles?.groupMembers?.(gid) ?? null);
  });

  await checkAsync('onebot_recall：没开存储时说明原因，而不是假装"没搜到"', async () => {
    // 本用例的 hub 配的是 persist:false —— 检索关掉时必须回一句人话，否则模型会把
    // "翻不到" 读成 "历史上没发生过"。
    const r = JSON.parse(await toolOf('onebot_recall').execute({ query: '天气' }));
    assert.equal(r.mode, 'off');
    assert.match(String(r.note), /没有开启存储/);
    assert.deepEqual(r.items, []);
    assert.equal(typeof r.stats.enabled, 'boolean');
  });

  await checkAsync('onebot_turns：没配存储也能配对（内存态），空表不编造', async () => {
    const r = JSON.parse(await toolOf('onebot_turns').execute({}));
    assert.equal(Array.isArray(r.turns), true);
    assert.equal(r.count, r.turns.length);
    assert.equal(typeof r.windowMs, 'number');
    assert.equal(typeof r.stats.turns, 'number');
    assert.deepEqual(r.unsolicited, []);
  });

  await checkAsync('onebot_turns：喂一条触发再查，配对视窗与静默判定都在', async () => {
    const t = toolOf('onebot_turns');
    hub.handleUpstreamEvent({
      post_type: 'message',
      message_type: 'group',
      sub_type: 'normal',
      self_id: '40004000',
      message_id: 9001,
      group_id: 55555,
      user_id: 10001,
      sender: { user_id: 10001, nickname: '小明', role: 'member', card: '' },
      message: [{ type: 'text', data: { text: '/试试' } }],
      raw_message: '/试试',
      font: 0,
      time: Math.floor(Date.now() / 1000),
    });
    const r = JSON.parse(await t.execute({ withOutcomes: true }));
    assert.equal(r.turns.length >= 1, true);
    assert.equal(r.turns[0].trigger.message_id, 9001);
    assert.equal(r.turns[0].silent, true, '没人响应就是沉默回合');
    assert.equal(r.turns[0].latencyMs, null);
    assert.equal(hub.turns.list({ limit: 1 }).count, 1);
    const reset = JSON.parse(await t.execute({ reset: true }));
    assert.equal(reset.reset, true);
    assert.equal(JSON.parse(await t.execute({})).count, 0);
  });

  await checkAsync('onebot_capabilities：读空表不编造，agent 写回与删除都落在同一张表上', async () => {
    const t = toolOf('onebot_capabilities');
    const empty = JSON.parse(await t.execute({}));
    assert.deepEqual(empty.items, []);
    assert.equal(empty.stats.enabled, true);
    assert.equal(empty.stats.total, 0);

    // 观测学习要有真证据：喂一条没人响应的消息不该建条目（只是候选，还进不了表）。
    hub.turns.record({
      direction: 'upstream-in',
      kind: 'group_message',
      sessionKey: 'group:55555',
      text: '/roll 10',
      refs: { message_id: 9101 },
      payload: { message: [{ type: 'text', data: { text: '/roll 10' } }] },
    });
    hub.turns.clear();
    assert.equal(JSON.parse(await t.execute({})).total, 0);
    assert.equal(hub.learn.size, 0);

    // agent 的语义判断写回来（§17.5）：名字/用法/示例都落在 notes 里。
    const wrote = JSON.parse(
      await t.execute({ upsert: '{"name":"roll","kind":"command","prefix":"/","aliases":["掷骰子"],"usage":"/roll 10","examples":["/roll 10"]}' }),
    );
    assert.equal(wrote.upsert.name, 'roll');
    assert.equal(wrote.upsert.source, 'manual');
    assert.equal(wrote.total, 1);
    assert.match(wrote.upsert.notes, /用法：\/roll 10/);
    assert.match(wrote.upsert.notes, /示例：\/roll 10/);

    const listed = JSON.parse(await t.execute({ query: '掷骰' }));
    assert.equal(listed.total, 1, '别名也查得到');
    assert.equal(listed.items[0].prefix, '/');

    const bad = JSON.parse(await t.execute({ upsert: '{不是 JSON' }));
    assert.equal(bad.ok, false);
    assert.match(String(bad.note), /不是合法 JSON/);

    const marked = JSON.parse(await t.execute({ stale: 'roll' }));
    assert.equal(marked.marked.status, 'stale');
    assert.equal(marked.total, 1, 'stale 是降置信，不是删');

    const gone = JSON.parse(await t.execute({ forget: 'roll' }));
    assert.equal(gone.removed.name, 'roll');
    assert.equal(gone.total, 0);
    assert.equal(JSON.parse(await t.execute({})).items.length, 0);
    assert.equal(JSON.parse(await t.execute({ forget: '不存在的东西' })).removed, null);
  });

  await checkAsync('onebot_relay_probe：先预测再动手，默认一个字节都不发（M7-③）', async () => {
    const t = toolOf('onebot_relay_probe');
    hub.learn.reset();
    hub.learn.upsert(
      { name: 'roll', prefix: '/', status: 'active', confidence: 3, args: { text: '点数' } },
      { source: 'observed' },
    );

    const dry = JSON.parse(await t.execute({ text: '/roll 10' }));
    assert.equal(dry.ok, true);
    assert.equal(dry.dryRun, true);
    assert.equal(dry.prediction.wouldTrigger, true);
    assert.equal(dry.prediction.exact, true);
    assert.equal(dry.prediction.best.name, 'roll');
    assert.equal(dry.prediction.best.confidence, 3);
    assert.equal(dry.prediction.sent, false, '默认只预测');
    assert.match(dry.prediction.note, /很可能触发/);
    assert.match(dry.prediction.note, /\/roll/);

    const miss = JSON.parse(await t.execute({ text: '今天天气不错' }));
    assert.equal(miss.prediction.wouldTrigger, false);
    assert.match(miss.prediction.note, /看不出会触发/);

    const noText = JSON.parse(await t.execute({}));
    assert.equal(noText.ok, false);

    // §16.6 的 `linkId?`：值是**上游**链路（知识库就是按它分的目录），
    // 对不上要明确回"不匹配"，不能静默地把整张表滤空（以前就是拿 `link` 当过滤条件）。
    const wrongLink = JSON.parse(await t.execute({ text: '/roll 10', linkId: 'up:ws://别的地方' }));
    assert.equal(wrongLink.ok, false);
    assert.match(wrongLink.note, /只接一条上游链路/);
    const sameLink = JSON.parse(await t.execute({ text: '/roll 10', linkId: hub.upstreamLinkId }));
    assert.equal(sameLink.prediction.wouldTrigger, true, '给对自己的链路应当照常预测');
    // `link`（真发时投给谁）不参与过滤：给一个下游 id 也不能把预测弄空。
    const withDownLink = JSON.parse(await t.execute({ text: '/roll 10', link: 'down:30001000' }));
    assert.equal(withDownLink.prediction.wouldTrigger, true, 'link 不该当过滤条件');

    // onebot_turns / onebot_capabilities 也认这个参数，且同样明确回"不匹配"。
    const turnsWrong = JSON.parse(await toolOf('onebot_turns').execute({ linkId: 'up:ws://别的地方' }));
    assert.equal(turnsWrong.ok, false);
    assert.match(turnsWrong.note, /只接一条上游链路/);
    const capsWrong = JSON.parse(await toolOf('onebot_capabilities').execute({ linkId: 'up:ws://别的地方' }));
    assert.equal(capsWrong.ok, false);
    assert.match(capsWrong.note, /只接一条上游链路/);

    // 真发要显式 confirm；没给就什么都不发（这是这一条工具的立身之本）。
    const refused = JSON.parse(await t.execute({ text: '/roll 10', dryRun: false }));
    assert.equal(refused.refused, true);
    assert.equal(refused.sent, false);
    assert.match(refused.note, /confirm/);
  });

  // ---- 七组功能（§26）新增工具：放在其它用例之后，避免它们的媒体落地/计数污染上面的断言 ----

  await checkAsync('onebot_reply：编造的表情包 id 在**执行侧**被丢掉，不会静默变成空回复', async () => {
    // 提示词里写"不要编造 id"是拦不住的：真发出去之前必须再查一遍库（§26）。
    await assert.rejects(
      () => toolOf('onebot_reply').execute({ text: '', memes: ['m99'] }),
      /这些表情包 id 不存在：m99/,
    );
  });

  await checkAsync('onebot_memes：库/清单/增删都说得清，没有可编造的空位', async () => {
    const t = toolOf('onebot_memes');
    const listed = JSON.parse(await t.execute({ action: 'list' }));
    assert.equal(listed.ok, true);
    assert.deepEqual(listed.items, []);
    assert.match(String(listed.promptText), /不要编造 id/);
    assert.equal(typeof listed.stats.capacity, 'number');
    // brief 是 agent 必填：没写简介就明确拒绝（方案 v2：简介由 agent 自己写）
    const noBrief = JSON.parse(await t.execute({ action: 'add', link: 'base64://iVBORw0KGgo=', keywords: '开心' }));
    assert.equal(noBrief.ok, false);
    assert.match(String(noBrief.error), /brief/);
    // 写了 brief 但存储关着（persist:false）时也不该骗人：如实说"拿不到图片字节"
    const added = JSON.parse(await t.execute({ action: 'add', link: 'base64://iVBORw0KGgo=', brief: '一只猫' }));
    assert.equal(added.ok, false);
    assert.equal(typeof added.error, 'string');
    const removed = JSON.parse(await t.execute({ action: 'remove', id: 'm1' }));
    assert.equal(removed.ok, false);
    const updated = JSON.parse(await t.execute({ action: 'update', id: 'm1', description: 'x' }));
    assert.match(String(updated.error), /没有这个 id/);
    const got = JSON.parse(await t.execute({ action: 'get', id: 'm1' }));
    assert.equal(got.ok, false);
    assert.match(String(got.error), /没有这个 id/);
  });

  await checkAsync('onebot_imagegen：没配置就说清楚缺什么，而不是发一张空图', async () => {
    const value = JSON.parse(await toolOf('onebot_imagegen').execute({ prompt: '一只猫' }));
    assert.equal(value.ok, false);
    assert.match(String(value.note), /生图未启用/);
    assert.match(String(value.note), /imageGen\.enabled/);
  });

  await checkAsync('ChatCommands 默认沉默：没配超管时整条链一个消息都不吞', async () => {
    assert.equal(hub.chatCommands, null, 'superUsers 为空时不该挂上命令处理器');
    assert.equal(hub.capabilitiesSnapshot().chatCommands, null);
  });

  await checkAsync('生图限额：每轮硬上限，超了就明确说"这轮画完了"（不是静默失败）', async () => {
    const quota = new Map();
    assert.deepEqual(claimImageQuota(quota, 'group:1#7', 1), { ok: true, used: 1, limit: 1 });
    assert.deepEqual(claimImageQuota(quota, 'group:1#7', 1), { ok: false, used: 1, limit: 1 });
    // 下一轮（新 key）重新领得到；limit=0 当 1 处理，绝不会退化成"无限"
    assert.equal(claimImageQuota(quota, 'group:1#8', 0).ok, true);
    assert.equal(claimImageQuota(quota, 'group:1#8', 1).ok, false);
  });

  await checkAsync('图片补描：晚到的看图描述在下一次唤醒按说话人补进 prompt，且取走即清', async () => {
    const sessionKey = 'private:10001';
    // resolveConfig 恒产出两张空名单（= 白名单已启用、生产默认 deny-all）：
    // 测试会话临时进名单，用完恢复，别让这条改动漏进别的用例。
    const savedPrivates = hub.config.agentPrivates;
    hub.config.agentPrivates = { ...savedPrivates, 10001: {} };
    try {
      const downstream = (id, text, who = '下游A') => ({
        sessionKey,
        action: 'send_msg',
        ts: Date.now(),
        text,
        label: who,
        entry: { id, sessionKey, ts: Date.now(), text, actor: { nickname: who }, live: null, refs: {} },
      });
      const lastPromptText = () => {
        const msg = recorded.followups.at(-1);
        const part = Array.isArray(msg?.content) ? msg.content.find((p) => p?.type === 'text') : null;
        return String(part?.text ?? '');
      };
      // ① 首轮渲染：批次带一条下游图片消息（描述还没生成 → 裸 [图片]），渲染后记入"已渲染"。
      hub.mind.noteDownstreamSend(downstream('ld-img-1', '[图片]（已存为 hub-media:abc）'));
      const first = await hub.mind.flush(sessionKey, { reason: 'test-render' });
      assert.equal(first.woke, true, `首轮应当真的唤醒一次：${first.reason}`);
      const firstText = lastPromptText();
      assert.ok(firstText.includes('[图片]'), '首轮只有裸 [图片]（描述晚到）');
      assert.ok(!firstText.includes('图片补描'), '首轮不该有补描块');
      // ② 描述晚到：hub 在看图写回后调 noteLateDescribe → 下一次唤醒按说话人带上。
      hub.mind.noteLateDescribe(
        { id: 'ld-img-1', sessionKey, ts: Date.now(), actor: { nickname: '下游A' } },
        new Map([[0, { text: '一只橘猫趴在键盘上' }]]),
      );
      hub.mind.noteDownstreamSend(downstream('ld-txt-2', '第二条'));
      const second = await hub.mind.flush(sessionKey, { reason: 'test-backfill' });
      assert.equal(second.woke, true, `次轮应当唤醒：${second.reason}`);
      const secondText = lastPromptText();
      assert.ok(secondText.includes('图片补描'), `次轮要带【图片补描】块：${secondText.slice(0, 200)}`);
      assert.ok(secondText.includes('一只橘猫趴在键盘上'), '补描块里要有描述文本');
      assert.ok(secondText.includes('下游A'), '补描要按说话人对上号');
      // ③ 取走即清：再下一轮不再重复。
      hub.mind.noteDownstreamSend(downstream('ld-txt-3', '第三条'));
      await hub.mind.flush(sessionKey, { reason: 'test-clear' });
      assert.ok(!lastPromptText().includes('图片补描'), '补描块是取走即清，不能每轮重复');
      // ④ 没渲染过的 entry 不补（下一批渲染时 live.text 自带描述，补了反而重复）。
      hub.mind.noteLateDescribe(
        { id: 'ld-img-fresh', sessionKey, ts: Date.now(), actor: { nickname: '下游B' } },
        new Map([[0, { text: '从未渲染的图' }]]),
      );
      hub.mind.noteDownstreamSend(downstream('ld-txt-4', '第四条', '下游B'));
      await hub.mind.flush(sessionKey, { reason: 'test-negative' });
      assert.ok(!lastPromptText().includes('从未渲染的图'), '没渲染过的 entry 不该被补描');
    } finally {
      hub.config.agentPrivates = savedPrivates;
    }
  });

  // ---- imageGen delivery（用户 2026-10-11 定）：agent 模式 = 落地+描述+不直发；direct = 老行为 ----
  const igMake = makeCtx();
  const igHub = apply(igMake.ctx, {
    upstreamUrl: '',
    upstreamSelfId: '30001000',
    downstreamTargets: '[]',
    agent: { mode: 'assist', batchMs: 500 },
    persist: false,
    imageGen: { enabled: true, model: 'test-model', baseUrl: 'https://img.example', apiKey: 'k', delivery: 'agent' },
  });
  await sleep(30);
  const igTools = probeHub(igHub).agentTools;

  await checkAsync('imageGen delivery=agent：落地 hub-media + 补描述 + 不自动直发', async () => {
    const igTool = igTools.find((t) => t.name === 'onebot_imagegen');
    assert.ok(igTool, 'builtin 引擎要注册 onebot_imagegen');
    assert.match(String(igTool.description), /不自动发群/, 'agent 模式的工具说明要讲清"不自动发"');
    const sentCalls = [];
    const pngBytes = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3, 4]);
    igHub.imageGen = {
      generate: async ({ prompt }) => ({ ok: true, bytes: pngBytes, mediaType: 'image/png', size: '1024x1024', prompt }),
    };
    const savedKinds = [];
    igHub.media = {
      saveBytes: async (bytes, opts = {}) => {
        savedKinds.push(opts.kind);
        return { id: 'hub-media:ig0001', kind: opts.kind, mediaType: opts.mediaType, bytes: bytes.length, attachmentId: 'att-1', attachment: { attachmentId: 'att-1' } };
      },
    };
    igHub.vision = {
      describeEnabled: true,
      enabled: true,
      describeImage: async ({ bytes, attachment }) => ({ text: `描述（${bytes.length}B，${attachment?.attachmentId}）` }),
    };
    igHub.callUpstream = async (action, params) => {
      sentCalls.push({ action, params });
      return { ok: true };
    };
    const value = JSON.parse(await igTool.execute({ prompt: '一只猫' }));
    assert.equal(value.ok, true);
    assert.equal(value.mode, 'agent');
    assert.equal(value.hubMedia, 'hub-media:ig0001');
    assert.match(String(value.description), /att-1/, '描述要走落地时登记的 attachment（不为同一张图再登记）');
    assert.deepEqual(savedKinds, ['image'], '生图落地按 image 类型登记');
    assert.equal(sentCalls.length, 0, 'agent 模式不该自己直发');
    assert.match(String(value.note), /onebot_reply/);
    assert.match(String(value.note), /hub-media:ig0001/);
  });

  await checkAsync('imageGen delivery=direct：直发保留老行为，结果也带 hubMedia 与描述', async () => {
    const igTool = igTools.find((t) => t.name === 'onebot_imagegen');
    igHub.config.imageGen.delivery = 'direct';
    try {
      const sentCalls = [];
      igHub.callUpstream = async (action, params) => {
        sentCalls.push({ action, params });
        return { ok: true };
      };
      const value = JSON.parse(await igTool.execute({ prompt: '一只狗', session_key: 'group:55555' }));
      assert.equal(value.mode, 'direct');
      assert.equal(sentCalls.length, 1, 'direct 模式要直发一次');
      assert.match(String(sentCalls[0]?.action), /group_msg|send_msg/);
      assert.equal(sentCalls[0]?.params?.group_id, '55555');
      assert.equal(value.hubMedia, 'hub-media:ig0001', 'sha256 相同 → 同一 hub-media 引用');
      assert.ok(value.description, 'direct 模式也带描述');
    } finally {
      igHub.config.imageGen.delivery = 'agent';
    }
  });

  await checkAsync('imageGen 落地失败：agent 模式退回 direct-fallback 直发，不浪费画好的图', async () => {
    const igTool = igTools.find((t) => t.name === 'onebot_imagegen');
    const realMedia = igHub.media;
    igHub.media = {
      saveBytes: async () => {
        throw new Error('disk full');
      },
    };
    try {
      const sentCalls = [];
      igHub.callUpstream = async (action, params) => {
        sentCalls.push({ action, params });
        return { ok: true };
      };
      const value = JSON.parse(await igTool.execute({ prompt: '一只鸟', session_key: 'private:10001' }));
      assert.equal(value.mode, 'direct-fallback', '落不了地就没法把图交到 agent 手里');
      assert.equal(sentCalls.length, 1, 'fallback 要真的发出去');
      assert.match(String(value.note), /direct/);
    } finally {
      igHub.media = realMedia;
    }
  });

  // ---- imageGen engine=plugin：hub 不自己生图，第三方工具进白名单 + post-execute 落地/描述 ----
  const pgMake = makeCtx({
    toolsSchemas: [
      { name: 'generate_image', description: '第三方生图' },
      { name: 'generate_images', description: '第三方批量生图' },
      { name: 'read', description: '读文件' },
    ],
  });
  const pgHub = apply(pgMake.ctx, {
    upstreamUrl: '',
    upstreamSelfId: '30001000',
    downstreamTargets: '[]',
    agent: { mode: 'assist', batchMs: 500 },
    persist: false,
    imageGen: { enabled: false, engine: 'plugin' },
  });
  await sleep(30);
  const pgTools = probeHub(pgHub).agentTools;

  await checkAsync('imageGen engine=plugin：不注册 onebot_imagegen，挂 tools/post-execute，引导段放行第三方工具', async () => {
    assert.equal(pgTools.find((t) => t.name === 'onebot_imagegen'), undefined, 'plugin 引擎不许再挂自带生图');
    const post = pgMake.recorded.onEvents.find((e) => e.name === 'tools/post-execute');
    assert.ok(post, 'plugin 引擎要挂 tools/post-execute');
    pgHub.media = {
      saveBytes: async (bytes, opts = {}) => ({ id: 'hub-media:pg0001', kind: opts.kind, attachment: { attachmentId: 'att-pg' } }),
    };
    pgHub.vision = {
      describeEnabled: true,
      enabled: true,
      describeImage: async () => ({ text: '一只像素猫' }),
    };
    const tmpPng = path.join(os.tmpdir(), `dsh-hub-test-${Date.now()}-${process.pid}.png`);
    fs.writeFileSync(tmpPng, Buffer.from([137, 80, 78, 71]));
    try {
      // ① 命中名单：先透传拿结果，再追加 [hub] 落地/描述/发送指引。
      const nextCalls = [];
      const decision = await post.handler(
        { name: 'generate_image' },
        {
          isError: false,
          value: { savedTo: tmpPng },
          content: [{ type: 'text', text: `Generated one image. It was also saved to the workspace as ${tmpPng}.` }],
        },
        async () => {
          nextCalls.push(1);
          return { kind: 'accept' };
        },
      );
      assert.equal(nextCalls.length, 1, 'matching 工具也要先透传（后面的监听器还要跑）');
      const last = String(decision.content.at(-1)?.text ?? '');
      assert.match(last, /hub-media:pg0001/);
      assert.match(last, /一只像素猫/);
      assert.match(last, /onebot_reply/);
      // ② 名单外工具：结果原样放行（引用相等）。
      const passthrough = { kind: 'accept', marker: true };
      const untouched = await post.handler({ name: 'read' }, { isError: false, value: 1, content: [] }, async () => passthrough);
      assert.equal(untouched, passthrough, '名单外工具不许动结果');
      // ③ isError 的结果不追加（失败的工具调用没有图可捡）。
      const errDecision = await post.handler(
        { name: 'generate_image' },
        { isError: true, value: { savedTo: tmpPng }, content: [] },
        async () => ({ kind: 'accept' }),
      );
      assert.ok(!errDecision.content?.length, 'isError 结果不追加 [hub] 块');
    } finally {
      fs.rmSync(tmpPng, { force: true });
    }
  });

  await checkAsync('imageGen engine=plugin：setup 引导段 + deny 不遮第三方工具', async () => {
    const savedPrivates = pgHub.config.agentPrivates;
    pgHub.config.agentPrivates = { ...savedPrivates, 10001: {} };
    try {
      pgMake.recorded.agentToolSchemas = [
        { name: 'generate_image', description: '第三方生图' },
        { name: 'read', description: '读文件' },
        { name: 'task_board_create', description: '任务板' },
        { name: 'subagent', description: '子代理' },
      ];
      pgHub.mind.noteDownstreamSend({
        sessionKey: 'private:10001',
        action: 'send_msg',
        ts: Date.now(),
        text: '画一只猫',
        label: '下游A',
        entry: { id: 'pg-1', sessionKey: 'private:10001', ts: Date.now(), text: '画一只猫', actor: { nickname: '下游A' }, live: null, refs: {} },
      });
      const r = await pgHub.mind.flush('private:10001', { reason: 'test-plugin-setup' });
      assert.equal(r.woke, true, `要真的唤醒一次：${r.reason}`);
      const section = pgMake.recorded.contexts.find((s) => s?.name === 'onebot-hub:imagegen');
      assert.ok(section, 'setup 要挂 onebot-hub:imagegen 引导段');
      assert.match(String(section.text), /generate_image/, '引导段要点名第三方工具');
      assert.match(String(section.text), /onebot_reply/, '引导段要教 onebot_reply 发图');
      const denyFilter = pgMake.recorded.agentRestricts.at(-1);
      assert.ok(denyFilter && Array.isArray(denyFilter.deny), 'setup 要真的应用遮罩名单');
      assert.ok(denyFilter.deny.includes('task_board_create') && denyFilter.deny.includes('subagent'), '第三方大件要被遮');
      assert.ok(!denyFilter.deny.includes('generate_image'), '第三方生图工具不能被遮（imageGen.plugin 靠它）');
      assert.ok(!denyFilter.deny.includes('read'), '基础工具不能被遮');
      assert.ok(!denyFilter.deny.includes('web_search'), '预设工具（哪怕晚注册）不在遮罩名单');
    } finally {
      pgHub.config.agentPrivates = savedPrivates;
      pgMake.recorded.agentToolSchemas = null;
    }
  });

  await checkAsync('onebot_tools：遮罩语义（默认遮第三方大件，enable/disable/all/slim 都走 deny）', async () => {
    const savedPrivates = pgHub.config.agentPrivates;
    pgHub.config.agentPrivates = { ...savedPrivates, 10001: {} };
    try {
      pgMake.recorded.agentToolSchemas = [
        { name: 'generate_image', description: '第三方生图' },
        { name: 'read', description: '读文件' },
        { name: 'task_board_create', description: '任务板' },
        { name: 'subagent', description: '子代理' },
        { name: 'web_search', description: '网搜' },
      ];
      pgHub.mind.noteDownstreamSend({
        sessionKey: 'private:10001',
        action: 'send_msg',
        ts: Date.now(),
        text: 'hi',
        label: '下游A',
        entry: { id: 'ot-1', sessionKey: 'private:10001', ts: Date.now(), text: 'hi', actor: { nickname: '下游A' }, live: null, refs: {} },
      });
      await pgHub.mind.flush('private:10001', { reason: 'test-onebot-tools' });
      pgHub.mind.activeSessionKey = 'private:10001';
      const def = pgTools.find((t) => t.name === 'onebot_tools');
      assert.ok(def, 'onebot_tools 要注册');
      // list：可见/被遮分两面报告；第三方生图走 pluginImageTools 不被遮。list:true 时 allowed 换成 canEnable 描述行。
      const listed = JSON.parse(await def.execute({ list: true }));
      assert.equal(listed.restricted, true, `默认应挂遮罩；响应=${JSON.stringify(listed)}`);
      assert.ok(listed.canEnable.some((s) => s.startsWith('task_board_create')) && listed.canEnable.some((s) => s.startsWith('subagent')), '第三方大件进 canEnable');
      assert.ok(!listed.canEnable.some((s) => s.startsWith('generate_image')), '生图工具不该出现在"被遮"里');
      const view0 = JSON.parse(await def.execute({}));
      assert.ok(view0.allowed.includes('read') && view0.allowed.includes('web_search') && view0.allowed.includes('generate_image'), '查询视图：可见名单正确');
      // enable / disable：动的是 deny 名单（enable=从名单删、disable=加进名单）。
      const after1 = JSON.parse(await def.execute({ enable: 'task_board_create', disable: 'read' }));
      assert.ok(after1.allowed.includes('task_board_create'), 'enable 后要可见');
      assert.ok(!after1.allowed.includes('read'), 'disable 后要被遮');
      assert.ok(after1.canEnable.includes('read'), '被遮的回到 canEnable');
      // all：解除遮罩，全景可见。
      const after2 = JSON.parse(await def.execute({ all: true }));
      assert.equal(after2.restricted, false, 'all 后无遮罩');
      assert.equal(after2.allowed.length, 5, 'all 后全景可见');
      // slim：回默认名单；晚注册的 web_search 天然可见（fail-open 的意义所在）。
      const after3 = JSON.parse(await def.execute({ slim: true }));
      assert.equal(after3.restricted, true, 'slim 后重新挂遮罩');
      assert.ok(after3.canEnable.includes('task_board_create') && after3.canEnable.includes('subagent'));
      assert.ok(after3.allowed.includes('web_search'), 'slim 名单不含 web_search，它必须可见');
    } finally {
      pgHub.config.agentPrivates = savedPrivates;
      pgMake.recorded.agentToolSchemas = null;
      pgHub.mind.activeSessionKey = null;
    }
  });

  await checkAsync('内置精简预设：默认建会话进它 + 点名 default 本回合后立即重开 + 整段会话保持全量工具面（同段第二条消息不弹回、休眠后的下一次激活才回精简，回程段带开局快照）+ 跨休眠点名与窗口都仍生效', async () => {
    const savedPrivates = pgHub.config.agentPrivates;
    pgHub.config.agentPrivates = { ...savedPrivates, 10001: {} };
    pgHub.mind.activeSessionKey = 'private:10001';
    try {
      pgMake.recorded.agentToolSchemas = [
        { name: 'read', description: '读文件' },
        { name: 'subagent', description: '子代理' },
      ];
      /** 一轮唤醒 = 一条下游发言 + 一次 flush（照遮罩语义用例的前置）。 */
      const round = async (n) => {
        // 先照真机那样落进时间线（hub.record），再 note 下游发言并带上 timelineId——
        // 开局快照读的是时间线（snapshot().events），没有这一步就造不出"这段之前聊到哪"。
        const entry = pgHub.timeline.record({
          direction: 'downstream-in',
          linkId: 'test-link',
          action: 'send_msg',
          decision: 'recorded',
          text: `m${n}`,
          refs: { sessionKey: 'private:10001' },
        });
        pgHub.mind.noteDownstreamSend({
          sessionKey: 'private:10001',
          action: 'send_msg',
          ts: Date.now(),
          text: `m${n}`,
          label: '下游A',
          timelineId: entry.id,
          entry: { ...entry, actor: { nickname: '下游A' } },
        });
        const r = await pgHub.mind.flush('private:10001', { reason: `test-preset-${n}` });
        assert.equal(r.woke, true, `第 ${n} 轮要真的唤醒：${r.reason}`);
      };
      const def = pgTools.find((t) => t.name === 'onebot_tools');
      assert.ok(def, 'onebot_tools 要注册（前面用例已注册，这里是同一份）');
      // 起手先交还上一组用例留下的活 agent，保证下面每一轮都是"新会话"（能看到 meta.agentPreset）。
      await pgHub.mind.pool.retire('private:10001', 'test-preset-reset');
      assert.equal(pgHub.preset.choice.size, 0, '干净起点：不该有排队中的点名');
      assert.equal(pgHub.preset.applied.size, 0, 'retire（休眠）要清活会话账');
      // recorded.created 是全部 pg 用例共享的，断言一律用相对起点的增量。
      const baseCreated = pgMake.recorded.created.length;

      // ① 内置精简预设（m04972 定案①，装配时已 register）：新会话 meta.agentPreset 进它，mount 也挂它。
      await round(1);
      assert.equal(pgMake.recorded.created.length, baseCreated + 1, '一轮唤醒恰好建一个新会话');
      const meta1 = pgMake.recorded.created.at(-1).meta;
      assert.equal(meta1.agentPreset, 'onebot-hub-slim', `create 的 meta 要带内置精简预设：${JSON.stringify(meta1)}`);
      assert.equal(pgMake.recorded.presetMounts.at(-1).id, 'onebot-hub-slim', 'setup 的 mount 要进内置精简预设');
      // m05750：slim 预设要带 6 行原生工具插件清单（照抄官方 standard 预设的对应行），
      // 否则 slim 会话里 read/grep/pwsh/web 等 11 个原生工具一个都没有。
      const slimDef = pgMake.recorded.presetRegisters.find((d) => d.id === 'onebot-hub-slim');
      assert.ok(slimDef, 'hub 装配时要注册内置精简预设');
      assert.equal(slimDef.plugins?.length, 6, `slim 清单要正好 6 行：${JSON.stringify(slimDef?.plugins)}`);
      const slimNames = slimDef.plugins.map((r) => r.name);
      for (const n of ['@deepseek-ai/dsh-tool-fs', '@deepseek-ai/dsh-tool-fs-search', '@deepseek-ai/dsh-tool-pwsh', '@deepseek-ai/dsh-tool-jobs', '@deepseek-ai/dsh-tool-web', '@deepseek-ai/dsh-tool-todo']) {
        assert.ok(slimNames.includes(n), `slim 清单缺 ${n}`);
      }
      const webRow = slimDef.plugins.find((r) => r.name === '@deepseek-ai/dsh-tool-web');
      assert.equal(webRow?.config?.fetch, true, 'tool-web 行要照抄官方 config（fetch:true）');
      assert.equal(process.platform !== 'win32', slimDef.plugins.find((r) => r.name === '@deepseek-ai/dsh-tool-pwsh').disabled, 'tool-pwsh 的 disabled 要跟平台走（同官方）');
      assert.equal(pgHub.preset.applied.get('private:10001'), 'slim', 'applied 账要记 slim');
      assert.equal(pgHub.preset.sessionPid.get('private:10001'), 'onebot-hub-slim', 'sessionPid 要记活会话的预设');

      // ② onebot_tools{preset:'default'}：点名后**本回合结束后立即重开**（m04972 定案③）——
      //    这里 flush 已落定，reawake 直接执行：交还旧会话、以 DSH 默认预设重开、备好说明段。
      const q1 = JSON.parse(await def.execute({ preset: 'default' }));
      assert.equal(q1.preset.queued, 'default', `要点名 default：${JSON.stringify(q1.preset)}`);
      assert.equal(q1.preset.current, 'slim', '点名瞬间当前形态还是 slim');
      assert.match(String(q1.note), /本回合/, 'note 要说"本回合结束立刻生效"');
      assert.equal(pgMake.recorded.created.length, baseCreated + 1, '点名瞬间不许建新会话（重开在回合后）');
      const reawakeResult = await pgHub.preset.lastReawake;
      assert.equal(reawakeResult?.woke, true, `裸激活要真的跑：${JSON.stringify(reawakeResult)}`);
      assert.equal(pgMake.recorded.created.length, baseCreated + 2, '重开要建新会话');
      // m12385 真机事故：换装出来的是**新会话**（转录是空的），所以裸激活必须自己递一份开局快照。
      // 只递"预设刚切换"这一句的话，模型看不到这段之前聊到哪——真机上它判"本轮无新对话内容"
      // 直接沉默，旧会话里已经答应过的事（"下次你喊我一声我就发清单"）也接不上。
      const reawakeFollowup = pgMake.recorded.followups.at(-1);
      const reawakeText = String(reawakeFollowup?.content?.[0]?.text ?? reawakeFollowup?.content ?? '');
      assert.match(reawakeText, /【开局快照】/, `裸激活要带开局快照：${reawakeText.slice(0, 200)}`);
      assert.match(reawakeText, /预设刚切换/, '裸激活要保留换装说明句');
      assert.match(reawakeText, /下游A|m1/, '快照里要有换装之前这段会话说过的话');
      const meta2 = pgMake.recorded.created.at(-1).meta;
      assert.equal(meta2.agentPreset, 'standard', `重开要进 DSH 默认预设：${JSON.stringify(meta2)}`);
      const notice = pgMake.recorded.contexts.filter((s) => s?.name === 'onebot-hub:preset');
      assert.ok(notice.length >= 1, '新会话要有 onebot-hub:preset 说明段（m04664）');
      assert.match(String(notice.at(-1).text), /默认预设/, '说明段要说"切到了默认预设"');
      assert.equal(pgHub.preset.applied.get('private:10001'), 'default', 'applied 账要记 default');
      assert.equal(pgHub.preset.sessionPid.get('private:10001'), 'standard', 'sessionPid 要跟着换');
      assert.equal(pgHub.preset.choice.get('private:10001'), pgHub.preset.windowTicket, '裸激活之后要挂**窗口**而不是回程票（切换自己那次裸激活不算"那一次"，m12814）');
      // "切到默认"的说明段里也提"这次激活结束后会自动切回"这句话，所以负断言用精简说明段独有的短语。
      assert.ok(!pgMake.recorded.contexts.some((s) => s?.name === 'onebot-hub:preset' && /大型工具已收起/.test(String(s.text))), '还没切回来，不该出现"精简"说明');

      // ③ 窗口覆盖那一次**真实**激活（m12814 立）：老规则"下一次唤醒就回程"会被切换自身那次
      //    裸激活吃掉，用户切完还没发过一条消息就被弹回精简（真机 m12699 复现两次）。
      //    所以带新消息的这一轮仍在 default 会话里（resume，不建新会话），
      //    这一轮结束时窗口**交付**——m12945：交付＝**删票**，不是排回程票。
      const noticeCount = pgMake.recorded.contexts.filter((s) => s?.name === 'onebot-hub:preset').length;
      await round(2);
      assert.equal(pgMake.recorded.created.length, baseCreated + 2, '窗口内的那次真实激活是 resume，不建新会话');
      assert.equal(pgMake.recorded.created.at(-1).meta.agentPreset, 'standard', '窗口内仍用 DSH 默认预设');
      assert.equal(pgHub.preset.choice.get('private:10001'), undefined, '那次真实激活结束后窗口交付（删票，不排回程票）');
      assert.equal(pgMake.recorded.contexts.filter((s) => s?.name === 'onebot-hub:preset').length, noticeCount, '窗口内不再出现说明段');

      // ③' 会话还活着时**再发一条**，必须还在 default（m12945 用户定案，也是真机那一条）：
      //     21:12 切 default → 21:14 第一条消息还在 default ✓ → 21:16 第二条消息开出来
      //     已经是 slim ✗。根因是窗口兑现时排了回程票 '__config__'——它 truthy，
      //     applyPresetSwitch 下一次唤醒把它当成"点名要切回精简"（desired=slim vs
      //     live=default）→ 走换装分支交还会话。删票之后这条不再成立。
      await round(3);
      assert.equal(pgMake.recorded.created.length, baseCreated + 2, '同段会话的第二条消息不许换出新会话（m12945）');
      assert.equal(pgMake.recorded.created.at(-1).meta.agentPreset, 'standard', '同段会话继续用 DSH 默认预设');
      assert.equal(pgHub.preset.choice.get('private:10001'), undefined, '交付过的窗口不该再留票');
      assert.equal(pgHub.preset.notice.size, 0, '说明账早就被 setup 取走了');

      // ③'' 回程交给**休眠**本身：回到休眠（代理 retire 清 applied/sessionPid）之后的
      //      **下一次激活**才建回精简（m12945："等回到休眠后下一次激活再弹回"）。
      //      这次是 create 而不是换装，但同样是空转录的新会话，开局快照照给——
      //      freshSession 判定问的是"有没有活会话"，不区分是换装出来的还是休眠后建的。
      await pgHub.mind.pool.retire('private:10001', 'test-preset-dormancy');
      assert.equal(pgHub.preset.applied.size, 0, '休眠清活会话账');
      await round(4);
      assert.equal(pgMake.recorded.created.length, baseCreated + 3, '休眠后的下一次激活要建新会话（交还 default、重开精简）');
      const meta3 = pgMake.recorded.created.at(-1).meta;
      assert.equal(meta3.agentPreset, 'onebot-hub-slim', `休眠后的下一次激活要回精简：${JSON.stringify(meta3)}`);
      assert.equal(pgMake.recorded.contexts.filter((s) => s?.name === 'onebot-hub:preset').length, noticeCount, '回切精简不再出现说明段（m05515）');
      assert.equal(pgHub.preset.notice.size, 0, '回切后说明账要空（只开全量时才设）');
      const backText = String(pgMake.recorded.followups.at(-1)?.content?.[0]?.text ?? '');
      assert.match(backText, /【开局快照】/, `休眠后建出来的新会话要带开局快照：${backText.slice(0, 200)}`);
      assert.match(backText, /下游A|m[1234]/, '快照里要有换装之前这段会话说过的话');

      // ④ 跨休眠点名仍生效（m04972 揪出的 bug 的回归测试）：点名 → 模拟休眠 retire →
      //    下一次唤醒照样按点名建 default 会话；**窗口也不随休眠清**（否则跨休眠就白切了）。
      const q2 = JSON.parse(await def.execute({ preset: 'default' }));
      assert.equal(q2.preset.queued, 'default', '再点名 default');
      await pgHub.preset.lastReawake; // 裸激活先落定（换装 + 挂窗口）
      await pgHub.mind.pool.retire('private:10001', 'test-preset-dormancy-2'); // 模拟休眠
      assert.equal(pgHub.preset.applied.size, 0, '休眠清活会话账');
      await round(5);
      assert.equal(pgMake.recorded.created.at(-1).meta.agentPreset, 'standard', '休眠后的那次真实激活仍落在 default（窗口跨休眠不被清）');
      assert.equal(pgHub.preset.choice.get('private:10001'), undefined, '跨休眠那一次交付窗口（删票）');
      await round(6);
      assert.equal(pgMake.recorded.created.at(-1).meta.agentPreset, 'standard', '交付后同段会话继续 default（回程交给休眠）');
      await pgHub.mind.pool.retire('private:10001', 'test-preset-dormancy-3');
      await round(7);
      assert.equal(pgMake.recorded.created.at(-1).meta.agentPreset, 'onebot-hub-slim', '再休眠一次之后才回精简');

      // ⑤ 不认识的档位：不排队、如实说；普通查询响应也带 preset 段（账目诚实）。
      const q3 = JSON.parse(await def.execute({ preset: 'bogus' }));
      assert.equal(q3.preset.queued, null, '不认识的不许排队');
      assert.match(String(q3.preset.note), /不认识/, '要如实说');
      assert.ok('preset' in JSON.parse(await def.execute({})), '普通查询响应也要带 preset 段');

      // ⑥ 同一段会话里的裸激活**不重复**递快照（m12385）：已是目标形态时点名，applyPresetSwitch
      //    消费点名就返回，唤醒的是同一段会话——那里的快照早在它自己那一轮给过了。
      const sameBefore = pgMake.recorded.followups.length;
      const q4 = JSON.parse(await def.execute({ preset: 'slim' }));
      assert.equal(q4.preset.queued, 'slim', '点名 slim（当前就是 slim）');
      await pgHub.preset.lastReawake;
      assert.ok(pgMake.recorded.followups.length > sameBefore, '同会话裸激活也要真的跑一次');
      const sameText = String(pgMake.recorded.followups.at(-1)?.content?.[0]?.text ?? '');
      assert.ok(!sameText.includes('【开局快照】'), `同一段会话的裸激活不许重复递快照：${sameText.slice(0, 200)}`);
    } finally {
      pgHub.config.agentPrivates = savedPrivates;
      for (const map of [pgHub.preset.choice, pgHub.preset.applied, pgHub.preset.sessionPid, pgHub.preset.notice]) map.clear();
      pgMake.recorded.agentToolSchemas = null;
      pgHub.mind.activeSessionKey = null;
    }
  });

  // 释放必须放在最后：agent 通道的 disposer 会拿掉 hostRef 并回收池。
  await checkAsync('release 全部 disposer 不抛异常，且之后唤醒退化而不崩', async () => {    for (const { dispose } of recorded.effects) dispose();
    assert.equal(hub.pool.host.create, null, 'dispose 后 host.create 未清空');
    assert.equal(hub.pool.size, 0, 'dispose 后池未清空');
    const r = await hub.pool.wake('group:55555', { text: 'x', setup: () => {} });
    assert.equal(r.ok, false);
    assert.match(String(r.error), /agent 通道未就绪/);
  });
}

// 真实 DSH 才能证明的部分：显式记录，不伪装成通过。
const agentSetupErrored = results.some((r) => r.label.startsWith('唤醒一次 agent') && !r.ok);
if (agentSetupErrored) {
  note('installModelSelection（假 agentCtx 不具代表性）', results.find((r) => r.label.startsWith('唤醒一次 agent'))?.error ?? '');
}

await runAsyncChecks();
await sleep(10);
const failed = results.filter((r) => !r.ok);
for (const r of results) {
  console.log(`${r.ok ? '  ok' : 'FAIL'}  ${r.label}${r.ok ? '' : `  → ${r.error}`}`);
}
for (const n of notes) console.log(` note  ${n.label}: ${n.text}`);
console.log(`\nload-check: ${results.length - failed.length}/${results.length} 通过`);
if (failed.length) process.exitCode = 1;
