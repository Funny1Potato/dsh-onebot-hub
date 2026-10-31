/**
 * 已知协议端的**事件能力**差异（`m71696` 三家核查的落地）。
 *
 * 动作能力我们有实测表（`lib/capability.js`）：调一次就知道支不支持。
 * 但“这家会不会推某类事件”试不出来——收不到就是收不到，只能查源码。三家结论：
 *
 * - LLOneBot v8.3.2：不推 `group_msg_emoji_like`、不推 `message_sent`，
 *   face 段也没有 `raw.faceText`（表情名只能靠我们内置的 329 条表翻）
 * - NapCat v4.18.42：三样全有（真机里同时见过 emoji_like 与 faceText）
 * - SnowLuma v2.2.1：源码里有 emoji_like 与 message_sent；faceText 我没找到确证
 *
 * `null` 一律表示“不知道”，不要当“不支持”——那会让模型放弃一个其实能用的能力。
 */

export const VENDORS = {
  llonebot: {
    label: 'LLOneBot',
    events: { faceText: false, emojiLike: false, messageSent: false },
    notes: ['不推表情回应通知', '不推自己消息回显', '表情段不带名字（靠内置表翻）'],
  },
  napcat: {
    label: 'NapCat',
    events: { faceText: true, emojiLike: true, messageSent: true },
    notes: [],
  },
  snowluma: {
    label: 'SnowLuma',
    events: { faceText: null, emojiLike: true, messageSent: true },
    notes: ['表情段带不带名字未确证'],
  },
};

/** app_name → 族名（`LLOneBot` / `llonebot` / `LuckyLilliaBot` 算同一家）。 */
export function vendorKeyOf(appName) {
  const s = String(appName ?? '').toLowerCase().replace(/[^a-z]/g, '');
  if (!s) return null;
  if (s.includes('llonebot') || s.includes('luckylillia')) return 'llonebot';
  if (s.includes('napcat')) return 'napcat';
  if (s.includes('snowluma')) return 'snowluma';
  return null;
}

/** 供 `onebot_caps` 输出：这家是谁、有哪些已知的事件差异。 */
export function vendorInfo(appName) {
  const key = vendorKeyOf(appName);
  const v = key ? VENDORS[key] : null;
  return {
    appName: appName ?? null,
    vendor: key,
    label: v?.label ?? (appName ? String(appName) : '未知实现端'),
    known: Boolean(v),
    events: v?.events ?? { faceText: null, emojiLike: null, messageSent: null },
    notes: v?.notes ?? [],
    hint: 'events 里的 null 表示未确证，不代表不支持。',
  };
}

/** 语音失败时补一句“这家的口味”（只有确证过的才说）。 */
