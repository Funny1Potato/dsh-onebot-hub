/**
 * 工具参数 schema 的 DSL 门卫测试（`node test/tool-schema.mjs`）。
 *
 * 为什么要单独一套：真机事故（2026-10-09）里，插件 `apply` 因为一个
 * `JsonSchemaError` 整个挂掉——设置页永远转圈、上下游都不连、插件行挂红标——
 * 而本地 68 项 load-check 全绿，因为 `test/stubs/dsh-tools.mjs` 当初只检查"是不是对象"。
 * 门卫本身也必须有测试，否则它自己坏掉时又是"一路绿灯"。
 */

import assert from 'node:assert/strict';

import { REPLY_PART_ITEM, REPLY_TOOL_PARAMS } from '../lib/reply.js';
import { assertSupportedJsonSchema } from './stubs/dsh-tools.mjs';

let passed = 0;
const cases = [];
function t(name, fn) {
  try {
    fn();
    passed += 1;
    cases.push({ name, ok: true });
  } catch (err) {
    cases.push({ name, ok: false, error: String(err?.message ?? err) });
  }
}

/** 断言这段 schema 被拒，并检查报错文本里点名了哪个键。 */
const rejects = (spec, needle) => () => {
  assert.throws(
    () => assertSupportedJsonSchema(spec),
    (err) => {
      assert.equal(err.name, 'JsonSchemaError', '必须是宿主那种 JsonSchemaError');
      assert.match(err.message, new RegExp(needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
      return true;
    },
  );
};

const obj = (extra = {}) => ({ type: 'object', additionalProperties: false, properties: { a: { type: 'string' } }, ...extra });

// ---- 门卫自己该拦的 ----------------------------------------------------------

t('数组元素里写 required：拒（真机事故本体）', rejects({ parts: { type: 'array', items: { type: 'object', ...obj(), required: ['a'] } } }, 'parts.items.required is not supported'));

t('对象节点不写 additionalProperties：拒', rejects({ x: { type: 'object', properties: { a: { type: 'string' } } } }, 'x.additionalProperties must be explicitly true or false'));

t('属性节点上写 required 数组：拒（宿主只认 true 标记）', rejects({ x: { ...obj(), required: ['a'] } }, 'x.required must be true when present'));

t('oneOf 与 type 同时声明：拒', rejects({ x: { type: 'string', oneOf: [{ type: 'string' }, { type: 'number' }] } }, 'x cannot declare both type and oneOf'));

t('oneOf 只有一个分支：拒', rejects({ x: { oneOf: [{ type: 'string' }] } }, 'x.oneOf must be an array of at least two value schemas'));

t('类型不认识：拒', rejects({ x: { type: 'strng' } }, 'x.type must be string/number/integer/boolean/null/array/object/json'));

t('没写 type 又没写 oneOf：拒', rejects({ x: { description: '只有注解' } }, 'x.type must be string'));

t('items 只配 array、properties 只配 object：类型配错就拒', rejects({ x: { ...obj(), items: { type: 'string' } } }, 'x.items is not supported by the value schema DSL'));

t('标量节点加 items：拒', rejects({ x: { type: 'string', items: obj() } }, 'x.items is not supported by the value schema DSL'));

t('空 enum：拒', rejects({ x: { type: 'string', enum: [] } }, 'x.enum must be a non-empty array of scalar values'));

t('description 不是字符串：拒', rejects({ x: { type: 'string', description: 42 } }, 'x.description must be a string'));

// 宿主拼路径时属性名是直接接在父节点后面的（没有 `.properties.` 这一段，见 `runSchemaCompiler` 的 property-map 任务）。
t('深层嵌套也照样查到（不只查一层）', rejects({ a: { ...obj(), properties: { b: { type: 'array', items: { type: 'object', properties: {} } } } } }, 'a.b.items.additionalProperties must be explicitly true or false'));

// ---- 插件自己的 schema 必须是过的 --------------------------------------------

t('onebot_reply 的参数表（含 parts 元素）过门卫', () => {
  assertSupportedJsonSchema(REPLY_TOOL_PARAMS);
});

t('parts 元素显式写了 additionalProperties: false', () => {
  assert.equal(REPLY_PART_ITEM.additionalProperties, false);
  assert.equal(Object.hasOwn(REPLY_PART_ITEM, 'required'), false, 'required 在 items 里必炸');
});

t('标量 + 数组 + 注解的常见组合都能过', () => {
  assertSupportedJsonSchema({
    s: { type: 'string', description: '字符串' },
    n: { type: 'number', description: '数字' },
    i: { type: 'integer', default: 3 },
    b: { type: 'boolean' },
    e: { type: 'string', enum: ['a', 'b'], description: '枚举' },
    a: { type: 'array', items: { type: 'string' }, description: '数组' },
    o: { type: 'object', additionalProperties: true, properties: { x: { type: 'string', description: 'x' } } },
    u: { oneOf: [{ type: 'string' }, { type: 'number' }], description: '二选一' },
    j: { type: 'json', description: '任意 JSON' },
  });
});

const failed = cases.filter((c) => !c.ok);
console.log(JSON.stringify({ passed, failed: failed.length, cases: failed }, null, 2));
if (failed.length) process.exitCode = 1;
