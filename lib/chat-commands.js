/**
 * 聊天里的管理命令（②，对标 master 的 6 条 on_alconna 管理命令）。
 *
 * 为什么要有这一层，而不是让 agent 自己去调工具：
 *  - 管理命令是**人**对 bot 的运维入口（改人设、看状态、重置会话），它的触发者必须是
 *    群里的超管，而不是模型。走工具面就等于让模型有机会自己改自己的设定——那不是"拟人"，
 *    那是失控。所以这里只认**消息文本**，完全不经过 agent 通道。
 *  - 命中之后**消息照常转发，枢纽额外回一条**（2026-10-07 定的）：`/` 是大家共用的前缀，
 *    下游插件很可能也有 `/status`，枢纽没有资格把它从转发链路上摘掉。前缀撞车时的语义是
 *    "两个都会触发"，不是"谁先谁赢"——想让枢纽别管某一条，才用 `bypassPrefix`。
 *  - 唯一被抑制的是**模型**：命中命令的消息不喂给 mind（hub 传 `silent: 'chat-command'`）。
 *    理由是枢纽已经用同一个账号答过这句话了，同一个账号对同一句话答两次是鬼故事。
 *    这不是"拦截消息"：消息一个字节都没少投下游。
 *  - 想连枢纽自己那条回话都不要：`bypassPrefix`（默认 `!!`）——`!!/help` 表示"这条别当命令
 *    看"，枢纽不执行也不回复，消息照常转发、照常给模型看。
 *
 * 权限只有一处判断：本文件 `isSuperUser`。超出名单的人敲命令 = 普通聊天，继续走正常转发，
 * **不回复任何东西**（回一句"你没权限"等于告诉整群这里有个能管事的 bot）。
 *
 * 本模块不 import 任何宿主包，也不碰网络：它只做「文本 → 命中 → 一段回话」，真正发出去由
 * hub 用上游链路完成（`hub.callUpstream('send_msg', …)`）。
 */

import { formatModelRef, renderModelList, resolveModelArg } from './models.js';

/** 命令前缀与绕开前缀的默认值（config `chatCommands.prefix` / `bypassPrefix` 可覆盖）。 */
export const DEFAULT_COMMAND_PREFIX = '/';
export const DEFAULT_BYPASS_PREFIX = '!!';

/** 回话长度上限：上游实现端对超长消息的处理各不相同，截断比被拒好。 */
export const DEFAULT_MAX_REPLY_CHARS = 800;

/**
 * 从入站事件里取"人打的那几个字"。
 *
 * 只取 text 段：`/status` 前面挂一个 `@bot` 是群里最常见的习惯，段序不能用来判断"命令
 * 是不是在开头"，否则 `@bot /status` 会被判成闲聊。at/图片/表情一律不进文本——它们不影响
 * 命令匹配，混进来只会让 `parseChatCommand` 的前缀判断出错。
 *
 * `event.message` 缺失时退回 `raw_message`，并**剥掉 CQ 码**（那串是给实现端看的编码，
 * 不是人打的字）。
 */
export function plainTextOf(event) {
  const segments = Array.isArray(event?.message) ? event.message : null;
  if (segments) {
    let out = '';
    for (const seg of segments) {
      if (seg?.type === 'text') out += String(seg.data?.text ?? '');
    }
    if (out) return out;
  }
  const raw = typeof event?.raw_message === 'string' ? event.raw_message : '';
  return raw.replace(/\[CQ:[^\]]*\]/g, '');
}

/**
 * 解析一条消息是不是命令。
 *
 * 返回：
 *  - `null` —— 不是命令（正常聊天）。
 *  - `{ bypass: true, text }` —— 带绕开前缀，意思是"这条别当枢纽的命令看"（消息照常转发、
 *    照常给模型看；枢纽只是不回话）。
 *  - `{ name, args, argv, text }` —— 是一条命令；`name` 已小写，`args` 是命令名之后的原文，
 *    `argv` 是按空白切开的参数。
 *
 * 只在**开头**认前缀（和 alconna 的默认行为一致）：`你好 /status` 是聊天，不是命令。
 */
export function parseChatCommand(text, { prefix = DEFAULT_COMMAND_PREFIX, bypassPrefix = DEFAULT_BYPASS_PREFIX } = {}) {
  const raw = String(text ?? '').trim();
  if (!raw) return null;
  if (bypassPrefix && raw.startsWith(bypassPrefix)) {
    return { bypass: true, text: raw.slice(bypassPrefix.length).trim() };
  }
  if (!prefix || !raw.startsWith(prefix)) return null;
  const body = raw.slice(prefix.length).trim();
  if (!body) return null;
  const [head, ...rest] = body.split(/\s+/);
  const name = String(head ?? '').toLowerCase();
  if (!name) return null;
  return { name, args: rest.join(' '), argv: rest, text: raw };
}

/** 超管判定：名单里的账号（字符串比较，容忍数字/字符串两种写法）。 */
export function isSuperUser(userId, list) {
  const id = userId === undefined || userId === null ? '' : String(userId);
  if (!id || !Array.isArray(list) || list.length === 0) return false;
  return list.some((item) => {
    const value = String(item ?? '').trim();
    if (!value) return false;
    // `*` 是"名单里没有具体的人"时的显式全开，写出来比留空更不容易被误当成"没配"。
    return value === '*' || value === id;
  });
}

/** 把长文本截断成一条能发出去的回话。 */
export function clipReply(text, max = DEFAULT_MAX_REPLY_CHARS) {
  const value = String(text ?? '');
  const limit = Number.isFinite(max) && max > 0 ? Math.floor(max) : DEFAULT_MAX_REPLY_CHARS;
  if (value.length <= limit) return value;
  return `${value.slice(0, Math.max(0, limit - 1))}…`;
}

/** 秒 → 人话（命令回话里到处要用）。 */
function humanDuration(ms) {
  const seconds = Math.max(0, Math.floor(Number(ms ?? 0) / 1000));
  if (seconds < 60) return `${seconds} 秒`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} 分钟`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时 ${minutes % 60} 分钟`;
  return `${Math.floor(hours / 24)} 天 ${hours % 24} 小时`;
}

function percent(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return '—';
  return `${Math.round(number * 100)}%`;
}

/**
 * 命令的 `usage` **不带前缀**（写 `set_role 名字`，不写 `/set_role 名字`）。
 *
 * 理由是前缀可配（`chatCommands.prefix`，默认 `/`）：把 `/` 写死在文案里，用户把前缀改成
 * `!` 之后 `/help` 会回一串"用 /status"，照它敲只会被当成普通聊天。所以**给人看的每一句
 * 都要经这里（或直接拼 `prefix`）生成**，不许出现写死的斜杠。
 *
 * 兼容"usage 里已经写了前缀"的老写法：认得出前缀字符就剥掉，免得拼出 `!!/model`。
 *
 * @param {{name?:string, usage?:string}} spec
 * @param {string} [prefix]
 * @returns {string} 形如 `/set_role 名字`
 */
export function usageLine(spec, prefix = DEFAULT_COMMAND_PREFIX) {
  const head = typeof prefix === 'string' ? prefix : DEFAULT_COMMAND_PREFIX;
  const usage = String(spec?.usage ?? spec?.name ?? '').trim();
  if (!usage) return head;
  return `${head}${usage.replace(/^[/!#。！]/, '')}`;
}

/**
 * `/model` 与 `/vmodel` 的公共实现（`m01993` 用户要的"按会话换模型"）。
 *
 * 无参 → 列出可选模型 + 本会话当前值；有参 → `provider/model` / 清单编号 / `default`。
 * 清单来自 `services.models.list()`（宿主 `llm.listProviders()` + `llm.listModels()`），
 * **拿不到就说拿不到**，绝不编几个模型名出来充数。文案一律用调用方给的前缀。
 */
async function runModelCommand({ services, argv, sessionKey, kind, prefix }) {
  const models = services?.models;
  const isVision = kind === 'vision';
  const label = isVision ? '识图模型' : '聊天模型';
  const bare = isVision ? 'vmodel' : 'model';
  const command = `${prefix ?? DEFAULT_COMMAND_PREFIX}${bare}`;
  if (!models) return `${label}换不了：这个部署没接上宿主 llm 通道。`;
  const arg = (argv ?? []).join(' ').trim();
  const providers = await models.list();
  const current = models.current?.(sessionKey, kind) ?? null;
  if (!arg) {
    return renderModelList({ providers, current, title: `本会话可选的${label}（${command}）`, prefix, command: bare });
  }
  const resolved = resolveModelArg(arg, providers);
  if (resolved?.kind === 'error') {
    return `${resolved.message}\n用法：${command} provider/model｜${command} 编号｜${command} default`;
  }
  const row = models.set(sessionKey, kind, resolved.kind === 'clear' ? null : resolved.ref) ?? {};
  const now = isVision ? row.vision : row.chat;
  if (now) return `${label}已切到 ${formatModelRef(now)}（只对本会话生效，立即生效）。`;
  // 复位回的"默认"可能被 hub 配置指定（`agent.defaultModel`/`defaultVisionModel`，m024167）：
  // 配了就说清楚回到哪个，没配才叫"系统默认"。
  const fallback = models.defaultRef?.(kind) ?? null;
  return fallback
    ? `${label}已回默认 ${formatModelRef(fallback)}（hub 配置的默认）。`
    : `${label}已回系统默认${isVision ? '模型' : '路由'}。`;
}

/**
 * 命令表。每条 `run(ctx)` 返回一段要发回去的中文文本（可以是 async）。
 *
 * `ctx` = `{ argv, args, text, sessionKey, event, services, self }`，其中 `services` 是
 * hub 上后挂的模块（persona / memes / anime / imageGen）。所有 `run` 都必须
 * **对缺失的服务降级成一句话**而不是抛错：命令面是运维入口，崩在这里会连"看状态"都做不到。
 */
export const COMMAND_SPECS = [
  {
    name: 'help',
    aliases: ['帮助', '?'],
    usage: 'help',
    summary: '看这张表',
    run: ({ services, prefix }) =>
      [
        `${services?.hub?.config?.nickname ?? '枢纽'} 的命令：`,
        ...COMMAND_SPECS.map((spec) => `${usageLine(spec, prefix)} — ${spec.summary}`),
      ].join('\n'),
  },
  {
    name: 'status',
    aliases: ['状态'],
    usage: 'status',
    summary: '上游/下游/模式/能量/人设 一屏概览',
    run: ({ services, sessionKey }) => {
      const hub = services?.hub;
      if (!hub) return '枢纽还没接上。';
      const state = hub.status();
      const upstream = state.upstream;
      const lines = [
        `链路：上游 ${upstream?.connected ? '已连接' : '未连接'}${upstream?.url ? `（${upstream.url}）` : ''}，下游 ${state.downstream.length} 条`,
        `模式：${state.policy?.preset ?? '—'}${hub.config?.agent?.mode ? `｜agent ${hub.config.agent.mode}` : ''}`,
        `时间线：${state.timeline?.total ?? 0} 条｜会话 ${state.timeline?.sessions ?? 0} 个｜运行 ${humanDuration(state.uptimeMs)}`,
      ];
      const persona = services?.persona?.resolve?.(sessionKey);
      if (persona) lines.push(`当前人设：${persona.name}${persona.role ? `｜${clipReply(persona.role, 40)}` : ''}`);
      const memes = services?.memes?.stats;
      if (memes) lines.push(`表情包：${memes.count ?? 0} 个`);
      return lines.join('\n');
    },
  },
  {
    name: 'presets',
    aliases: ['preset', '预设'],
    usage: 'presets',
    summary: '列出可用人设预设',
    run: ({ services, sessionKey }) => {
      const persona = services?.persona;
      if (!persona) return '人设模块未接入。';
      const list = persona.list?.() ?? [];
      const bound = persona.boundName?.(sessionKey) ?? null;
      const lines = list.map((preset) => `${preset.name === bound ? '→' : '·'} ${preset.name}${preset.role ? ` — ${clipReply(preset.role, 40)}` : ''}`);
      return [`可用预设（→ 表示本会话在用）：`, ...lines].join('\n');
    },
  },
  {
    name: 'set_preset',
    aliases: ['set_presets', '设置预设'],
    usage: 'set_preset <预设名>',
    summary: '把本会话切到某个预设',
    run: ({ services, sessionKey, argv, prefix }) => {
      const persona = services?.persona;
      if (!persona) return '人设模块未接入。';
      const name = argv?.[0];
      if (!name) return `用法：${prefix}set_preset <预设名>，名字可以用 ${prefix}presets 看。`;
      if (!persona.has?.(name)) return `没有叫「${name}」的预设。`;
      persona.bind(sessionKey, name);
      return `本会话已切到「${name}」。`;
    },
  },
  {
    name: 'set_role',
    aliases: ['设置角色'],
    usage: 'set_role <名字> <设定>',
    summary: '临时给本会话换个角色名和设定',
    run: ({ services, sessionKey, argv, prefix }) => {
      const persona = services?.persona;
      if (!persona) return '人设模块未接入。';
      const name = argv?.[0];
      const role = argv?.slice(1).join(' ');
      if (!name) return `用法：${prefix}set_role <名字> <设定>。只想改设定不换名字的话，用 ${prefix}preset_role <设定>。`;
      persona.setRole(sessionKey, role ? { name, role } : { name });
      const preset = persona.resolve(sessionKey);
      return `本会话人设：${preset.name}${preset.role ? ` — ${clipReply(preset.role, 60)}` : ''}`;
    },
  },
  {
    name: 'preset_role',
    aliases: ['设置设定'],
    usage: 'preset_role <设定>',
    summary: '只改设定，不改角色名',
    run: ({ services, sessionKey, argv, prefix }) => {
      const persona = services?.persona;
      if (!persona) return '人设模块未接入。';
      const role = (argv ?? []).join(' ');
      if (!role) return `用法：${prefix}preset_role <设定>。`;
      persona.setRole(sessionKey, { role });
      return `本会话设定已更新（角色名不变：${persona.resolve(sessionKey).name}）。`;
    },
  },
  {
    name: 'memes',
    aliases: ['表情包', 'meme'],
    usage: 'memes [del <id>]',
    summary: '看表情包库（或删掉某个）',
    run: ({ services, argv, prefix }) => {
      const memes = services?.memes;
      if (!memes) return '表情包模块未接入。';
      const [sub, id] = argv ?? [];
      if (sub === 'del' || sub === '删除') {
        if (!id) return `用法：${prefix}memes del <id>。`;
        return memes.remove?.(id) ? `已删掉 ${id}。` : `没有 ${id} 这个表情包。`;
      }
      const list = memes.list?.() ?? [];
      const stats = memes.stats ?? {};
      const lines = list
        .slice(-10)
        .map((entry) => `· ${entry.id}${entry.description ? ` ${clipReply(entry.description, 40)}` : ''}${(entry.keywords ?? []).length ? `（${entry.keywords.join('、')}）` : ''}`);
      return [`表情包 ${stats.count ?? list.length}/${stats.capacity ?? '—'} 个：`, ...(lines.length ? lines : ['（空）'])].join('\n');
    },
  },
  {
    name: 'reload_meme',
    aliases: ['重载表情包'],
    usage: 'reload_meme',
    summary: '重新从磁盘读一遍表情包索引',
    run: ({ services }) => {
      const memes = services?.memes;
      if (!memes) return '表情包模块未接入。';
      memes.load?.();
      return `表情包索引已重载：${memes.stats?.count ?? 0} 个。`;
    },
  },
  {
    name: 'perm',
    aliases: ['permission', '权限'],
    usage: 'perm [预设名]',
    summary: '看本会话 agent 的权限预设，或换成某个',
    /**
     * 权限只能设在"真的存在的"会话上，而且要拿宿主的 `permissionPresets`/`sessions` 服务，
     * 所以判定与执行都在 `services.perms` 里（index.js 装配时挂上）；这里只管转发参数。
     * 它**不是**给模型看的开关：改的是枢纽自建的那个 agent 会话（`onebot-hub:<会话键>`）的权限。
     */
    run: ({ services, argv, sessionKey }) => {
      const perms = services?.perms;
      if (!perms) return '权限预设没接上：这个部署没有 permissionPresets / sessions 服务。';
      const name = argv?.[0];
      return name ? perms.setPreset(name, { sessionKey }) : perms.describe({ sessionKey });
    },
  },
  {
    name: 'model',
    aliases: ['模型', '聊天模型'],
    usage: 'model [provider/model|编号|default]',
    summary: '看/换本会话的聊天模型（只影响这个会话）',
    /**
     * 聊天模型换的是**枢纽自建的那个 agent 会话**（`onebot-hub:<会话键>`）的路由：
     * 宿主 `installModelSelection` 每轮装配时读那个可变 selection，所以改完**下一轮就生效**，
     * 宿主自己还会追加一条"模型已变更"的会话通知。清单与写入都在 `services.models` 里。
     */
    run: (ctx) => runModelCommand({ ...ctx, kind: 'chat' }),
  },
  {
    name: 'vmodel',
    aliases: ['视觉模型', '识图模型'],
    usage: 'vmodel [provider/model|编号|default]',
    summary: '看/换本会话的识图模型（默认系统默认模型）',
    run: (ctx) => runModelCommand({ ...ctx, kind: 'vision' }),
  },
  {
    name: 'reset',
    aliases: ['重置'],
    usage: 'reset',
    summary: '本会话的人设绑定与模型选择回到初始（**不动长期记忆**）',
    run: ({ services, sessionKey }) => {
      const done = [];
      if (services?.persona?.unbind?.(sessionKey)) done.push('人设绑定回默认');
      // 会话级模型选择（`/model`、`/vmodel`）也算"本会话的设定"，一并清掉回系统默认。
      const row = services?.hub?.models?.get?.(sessionKey);
      if (row?.chat || row?.vision) {
        services.models?.set?.(sessionKey, 'chat', null);
        services.models?.set?.(sessionKey, 'vision', null);
        done.push('模型选择回系统默认');
      }
      done.push('长期记忆与时间线**没动**（那是可检索的历史，不该被一条命令抹掉）');
      return `本会话已重置：${done.join('；')}。`;
    },
  },
];

/** 命令名 → spec（含别名）。 */
export const COMMAND_INDEX = (() => {
  const index = new Map();
  for (const spec of COMMAND_SPECS) {
    index.set(spec.name, spec);
    for (const alias of spec.aliases ?? []) index.set(String(alias).toLowerCase(), spec);
  }
  return index;
})();

/**
 * 命令路由器。
 *
 * 它**不做 IO**：命中后只回一段文本，由 hub 决定怎么发、发去哪儿。这样测试不用起网络，
 * 也能保证"枢纽自己回一条、消息照常转发"这条分工只在一个地方实现（hub 里那个
 * 「回话 + 继续投下游 + 只对模型静音」的分支）。
 */
export class ChatCommands {
  constructor({ log = () => {}, services = {}, config = {} } = {}) {
    this.log = log;
    /** 后挂模块的**活引用**（index.js 装配完之后填），所以这里存对象本身而不是解构字段。 */
    this.services = services;
    this.config = config;
    this.prefix = typeof config.prefix === 'string' && config.prefix ? config.prefix : DEFAULT_COMMAND_PREFIX;
    this.bypassPrefix =
      typeof config.bypassPrefix === 'string' && config.bypassPrefix ? config.bypassPrefix : DEFAULT_BYPASS_PREFIX;
    this.superUsers = Array.isArray(config.superUsers) ? config.superUsers : [];
    this.maxReplyChars = config.maxReplyChars ?? DEFAULT_MAX_REPLY_CHARS;
    this.enabled = config.enabled !== false;
    this.stats = { seen: 0, handled: 0, denied: 0, bypassed: 0, unknown: 0, failed: 0, lastCommand: null, lastAt: null, lastError: null };
  }

  /** 命令面**能不能用**：关掉，或者一个超管都没配。没配超管时整条链沉默，不给"猜猜谁能用"。 */
  get active() {
    return this.enabled && this.superUsers.length > 0;
  }

  /** 找不到人却还在敲命令时，只记一笔，不回话。 */
  describe() {
    return {
      enabled: this.enabled,
      active: this.active,
      prefix: this.prefix,
      bypassPrefix: this.bypassPrefix,
      superUsers: this.superUsers.length,
      commands: COMMAND_SPECS.map((spec) => spec.name),
      stats: { ...this.stats },
    };
  }

  /**
   * **同步**判定这条消息要不要枢纽自己动手——真正的分诊台，也会记账，但不执行、不做 IO。
   *
   * 之所以把它从 `handle` 里拆出来：命令回话要等网络（`run` 是异步的），而 hub 的转发主链路
   * 是同步的、且**不取决于这个判定**。有了这个同步入口，hub 就能"先决定要不要回话、然后照常
   * 往前转发"，不必为了等一次回话把转发拖成异步。
   *
   * 返回 `{ act, reason, command, spec, parsed, sessionKey }`：
   *  - `act: true` —— 超管敲的已知命令；hub 自己执行并用上游身份回一条，并且**不把这条喂给
   *    模型**（回话已经用同一个账号发过了）。注意它**不代表消息被拦下**：转发该照常照常。
   *  - 其余一律 `act: false`，消息按普通聊天继续走（`denied`/`unknown`/`bypass` 只记账）。
   */
  classify({ event, text, userId, sessionKey } = {}) {
    if (!this.active) return { act: false, reason: 'inactive' };
    if (!event || event.post_type !== 'message') return { act: false, reason: 'not-message' };
    const source = text === undefined ? plainTextOf(event) : text;
    const parsed = parseChatCommand(source, { prefix: this.prefix, bypassPrefix: this.bypassPrefix });
    if (!parsed) return { act: false, reason: 'not-command' };
    this.stats.seen += 1;
    if (parsed.bypass) {
      this.stats.bypassed += 1;
      return { act: false, reason: 'bypass' };
    }
    const actor = userId === undefined ? event.user_id : userId;
    if (!isSuperUser(actor, this.superUsers)) {
      // 不回"你没权限"：那等于在群里公告"这里有个 bot 能管事"。
      this.stats.denied += 1;
      return { act: false, reason: 'not-superuser', command: parsed.name, parsed, sessionKey };
    }
    const spec = COMMAND_INDEX.get(parsed.name);
    if (!spec) {
      this.stats.unknown += 1;
      return { act: false, reason: 'unknown-command', command: parsed.name, parsed, sessionKey };
    }
    return { act: true, reason: 'ok', command: spec.name, spec, parsed, sessionKey };
  }

  /**
   * 执行一条**已经 `classify` 判定为命中**的命令，返回 `{ok, reply}`——`reply` 是要发回去的文本
   * （失败也有一句话），`ok:false` 表示是失败兜底而不是正常输出。单独成方法是为了让 hub 能
   * "先同步判定、再异步（且不挡转发地）回话"。
   */
  async run(verdict, { sessionKey, event } = {}) {
    const parsed = verdict?.parsed ?? { argv: [], args: '', text: '' };
    const spec = verdict?.spec;
    if (!spec) return { ok: false, reply: '' };
    const started = Date.now();
    try {
      const reply = await spec.run({
        argv: parsed.argv,
        args: parsed.args,
        text: parsed.text,
        sessionKey: sessionKey ?? verdict?.sessionKey ?? '',
        event,
        prefix: this.prefix,
        services: this.services,
      });
      this.stats.handled += 1;
      this.stats.lastCommand = spec.name;
      this.stats.lastAt = started;
      this.log(`聊天命令 /${spec.name} 已处理（${sessionKey ?? verdict?.sessionKey}，${Date.now() - started}ms）`);
      return { ok: true, reply: clipReply(reply, this.maxReplyChars) };
    } catch (err) {
      this.stats.failed += 1;
      this.stats.lastError = { command: spec.name, at: started, message: String(err?.message ?? err) };
      this.log(`聊天命令 /${spec.name} 失败：${err?.message ?? err}`);
      // 命令炸了也要回一句：运维看不到回话会以为是"没收到"，然后反复敲。
      return { ok: false, reply: `/${spec.name} 执行失败：${String(err?.message ?? err)}` };
    }
  }

  /**
   * 一步到位：判定 + 执行（测试和"不关心同步语义"的调用方用这个）。
   *
   * 返回 `{ handled:boolean, reply:string|null, command:string|null, reason?:string }`。
   * `handled: true` 只表示"枢纽回了一条"，**不表示消息被拦下**——转发是 hub 那条主链路的事，
   * 这里连碰都没碰过它（`handle` 只是给测试和"不关心同步语义"的调用方用的一步到位版本）。
   * 未命中（不是命令 / 不是超管 / 未知命令）一律 `handled:false`，消息照常走正常流程。
   */
  async handle({ event, sessionKey, text, userId } = {}) {
    const verdict = this.classify({ event, text, userId, sessionKey });
    if (!verdict.act) {
      return { handled: false, reply: null, command: verdict.command ?? null, reason: verdict.reason };
    }
    const out = await this.run(verdict, { sessionKey, event });
    return { handled: true, reply: out.reply, command: verdict.command, reason: out.ok ? 'ok' : 'error' };
  }
}
