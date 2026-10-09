/**
 * 仅测试用的桩：`@deepseek-ai/dsh-tools` 的真身在 app.asar 内，纯 node 解析不到。
 * 见 `test/stub-hooks.mjs`（只在 `test/load-check.mjs` 的跑法里挂载）。
 *
 * 关键点：**这里必须照抄宿主对工具参数 schema 的校验**（`assertSupportedJsonSchema` +
 * `runSchemaCompiler`）。不照抄就等于替插件把门卫撤了——真机上 `defineTool` 抛一个
 * `JsonSchemaError`，整个插件 `apply` 就挂掉：设置页永远停在"正在读取本插件的配置…"、
 * 上下游都不连、插件列表挂红标，而本地测试一路绿灯。
 *
 * 这不是假设，是真机事故（2026-10-09）：`onebot_reply` 的 `parts.items` 写了 `required: ['type']`，
 * 真机 apply 在 `lib/index.js` 工具注册那一行抛 `unsupported JSON schema: parameters.parts.items.required
 * is not supported by the value schema DSL`，插件直接起不来；本地因为桩只检查"是不是对象"一路放行。
 *
 * 照抄的规则（来自 `app.asar/dsh/node_modules/@deepseek-ai/dsh-tools/lib/index.js`）：
 *  - 注解键 `description/title/default/examples` 到处都能写（`description`/`title` 必须是字符串）；
 *  - `required` **只在对象属性节点上合法**（宿主 `allowRequired: true` 只在 property-map 的子节点传入）；
 *    属性节点上的 `required` 只能是 `true` 标记，父级 `required` 数组由宿主编译期生成；
 *    数组 `items` 与 `oneOf` 分支都是 `allowRequired: false`，写了就报 unsupported；
 *  - **对象节点必须显式写 `additionalProperties: true|false`**（缺了直接 `authorError`）；
 *  - `oneOf` 与 `type` 不能同时声明，`oneOf` 至少两项，分支各自再校验；
 *  - 标量类型可加 `enum`/`const`；`type` 缺省或写错类型一律报 "must be … or use oneOf"。
 */

/** 注解键：DSL 原样搬运，不参与词汇检查。 */
const ANNOTATION_KEYS = ['description', 'title', 'default', 'examples'];

/** 宿主认识的类型（`runSchemaCompiler` 的 switch 全集）。 */
const SCALAR_TYPES = ['string', 'number', 'integer', 'boolean', 'null'];

/**
 * 抛一个作者 schema 违例。
 *
 * **自己 throw，不要返回**——写成"返回错误"曾经让整套校验静默放行（漏一个 throw 就等于没校验），
 * 那正是这次真机事故要防的东西。
 * @returns {never}
 */
function authorError(message) {
  const err = new Error(`unsupported JSON schema: ${message}`);
  err.name = 'JsonSchemaError';
  throw err;
}

function isRecord(v) {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

/** 注解必须是"无损 JSON"，`description`/`title` 还得是字符串（宿主 `copyAnnotations`）。 */
function checkAnnotations(node, path) {
  for (const key of ['description', 'title']) {
    if (Object.hasOwn(node, key) && typeof node[key] !== 'string') authorError(`${path}.${key} must be a string`);
  }
  for (const key of ANNOTATION_KEYS) {
    if (!Object.hasOwn(node, key)) continue;
    const value = node[key];
    if (value === undefined || typeof value === 'function' || typeof value === 'symbol') {
      authorError(`${path}.${key} is not lossless JSON`);
    }
    try {
      JSON.stringify(value);
    } catch {
      authorError(`${path}.${key} is not lossless JSON`);
    }
  }
}

function assertKeys(node, path, allowed) {
  for (const key of Object.keys(node)) {
    if (!allowed.includes(key)) authorError(`${path}.${key} is not supported by the value schema DSL`);
  }
}

/** 属性节点：宿主要求 `required` 只能是 `true` 标记（真数组由父级生成）。 */
function checkProperty(node, path, key) {
  if (!isRecord(node)) authorError(`${path}.${key} must be a value schema object`);
  if (Object.hasOwn(node, 'required') && node.required !== true) {
    authorError(`${path}.${key}.required must be true when present`);
  }
  checkValueSchema(node, `${path}.${key}`, true);
}

/**
 * @param {object} node 待校验的 schema 节点
 * @param {string} path 报错路径（如 `parameters.parts.items`）
 * @param {boolean} allowRequired `required` 在这里合不合法（宿主同名 flag）
 */
function checkValueSchema(node, path, allowRequired) {
  if (!isRecord(node)) authorError(`${path} must be a value schema object`);
  checkAnnotations(node, path);
  const authorKeys = [...ANNOTATION_KEYS, ...(allowRequired ? ['required'] : [])];

  // ---- oneOf 分支：可写 `oneOf` 与 `type`（但不能同时出现），分支一律 allowRequired:false ----
  if (Object.hasOwn(node, 'oneOf')) {
    assertKeys(node, path, [...authorKeys, 'oneOf', 'type']);
    if (Object.hasOwn(node, 'type')) authorError(`${path} cannot declare both type and oneOf`);
    if (!Array.isArray(node.oneOf) || node.oneOf.length < 2) {
      authorError(`${path}.oneOf must be an array of at least two value schemas`);
    }
    node.oneOf.forEach((branch, index) => checkValueSchema(branch, `${path}.oneOf[${index}]`, false));
    return;
  }

  const type = Object.hasOwn(node, 'type') ? node.type : undefined;
  switch (type) {
    case 'json':
      assertKeys(node, path, [...authorKeys, 'type']);
      return;
    case 'object': {
      assertKeys(node, path, [...authorKeys, 'type', 'properties', 'additionalProperties']);
      if (typeof node.additionalProperties !== 'boolean') {
        authorError(`${path}.additionalProperties must be explicitly true or false`);
      }
      if (!isRecord(node.properties)) authorError(`${path}.properties must be an object of value schemas`);
      for (const [key, child] of Object.entries(node.properties)) checkProperty(child, path, key);
      return;
    }
    case 'array': {
      assertKeys(node, path, [...authorKeys, 'type', 'items']);
      // 数组元素：宿主传下来的 allowRequired 是 false —— 这里写 `required` 必炸。
      checkValueSchema(node.items, `${path}.items`, false);
      return;
    }
    case 'string':
    case 'number':
    case 'integer':
    case 'boolean':
    case 'null':
      assertKeys(node, path, [...authorKeys, 'type', 'enum', 'const']);
      if (Object.hasOwn(node, 'enum') && (!Array.isArray(node.enum) || node.enum.length === 0)) {
        authorError(`${path}.enum must be a non-empty array of scalar values`);
      }
      return;
    default:
      authorError(`${path}.type must be string/number/integer/boolean/null/array/object/json, or use oneOf`);
  }
}

/**
 * 宿主 `parameterSchemaSpecToJsonSchema(spec)` 的等价物：根是隐式对象，
 * 每个键都是"属性节点"（allowRequired=true），根上不要求 `additionalProperties`。
 */
export function assertSupportedJsonSchema(spec) {
  if (!isRecord(spec)) authorError('parameters must be an object of value schemas');
  for (const [key, node] of Object.entries(spec)) checkProperty(node, 'parameters', key);
}

export function defineTool(definition) {
  if (!definition || typeof definition !== 'object') throw new Error('defineTool 需要定义对象');
  if (!definition.name) throw new Error('defineTool 需要 name');
  assertSupportedJsonSchema(definition.parameters);
  return definition;
}
