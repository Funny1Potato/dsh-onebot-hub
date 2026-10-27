/**
 * 语音合成的各家用例（`tts.provider` 那个下拉的内容）。
 *
 * 为什么是"预设"而不是"适配器类"：这五家的差异**几乎全在请求体与返回形状**上，而
 * 形状本来就已经是 `tts.shape` 这个可配项了。所以这里只登记三样东西——地址、形状、
 * 模型的默认名——选了下拉就等于把这三项填好；想手填就把服务商切回 `自定义`（`m29830`：
 * 上一版是"显式优先"，结果切了服务商之后手填的旧值还在偷偷生效，设置页却看不见它们）。
 *
 * 地址是**完整**地址，不拼路径：MiMo 把 TTS 挂在 `chat/completions` 上（`m29304` 的
 * 真机证据：`/audio/speech` 在那边是 404），百炼挂在 `multimodal-generation` 上，
 * 没有任何一条共同的尾巴可以拼。
 */

/** 形状 → 一句话说明（设置页提示用，也解释给用户听）。 */
export const SHAPE_HINTS = {
  speech: 'OpenAI `input`/`voice`/`response_format` 那一套，返回二进制音频',
  chat: '把要读的话当成 `assistant` 消息（小米 MiMo）',
  minimax: '`text` + `voice_setting`/`audio_setting`，返回 hex 编码的音频（老账号要拼 `?GroupId=`）',
  dashscope: '`input:{text,voice}`，返回音频 URL',
  doubao: '`app`/`user`/`audio`/`request` 四段（豆包语音 V1），`Authorization: Bearer; token`，返回 base64',
  plugin: '不自己合成：交给第三方插件的工具，模型自己调',
};

/** 所有形状的 id（schema / 测试共用一份，防漂移）。 */
export const SHAPE_IDS = Object.keys(SHAPE_HINTS);

/**
 * 地址 / 形状 / 模型最终取谁（`m29830`）：**选了一家就用它那一套，只有 `custom` 才用用户填的**。
 *
 * 上一版是"显式写的永远优先"，于是切了服务商之后那几个手填的旧值还在偷偷生效——设置页
 * 已经把这几格藏起来了，代码却还听它们的，就成了"看不见的配置在管事"。现在换过来：
 * 选了谁就按谁；想手填就把服务商切回 `自定义`，那时填的才算数（旧值没被清掉，切回来还在）。
 */
export const resolveTtsTarget = ({ provider, url, shape, model } = {}) => {
  const preset = providerOf(provider);
  if (preset.id !== 'custom') {
    return {
      provider: preset.id,
      url: preset.url || '',
      shape: preset.shape || 'speech',
      model: preset.model || '',
    };
  }
  const shapeId = String(shape ?? '').trim().toLowerCase();
  return {
    provider: 'custom',
    url: String(url ?? '').trim(),
    shape: SHAPE_IDS.includes(shapeId) ? shapeId : 'speech',
    model: String(model ?? '').trim(),
  };
};

export const TTS_PROVIDERS = [
  {
    id: 'custom',
    label: '自定义（下面自己填）',
    url: '',
    shape: '',
    model: '',
    note: '地址、形状、模型全自己填。自建中转、私有部署都走这条。',
  },
  {
    id: 'openai',
    label: 'OpenAI 官方',
    url: 'https://api.openai.com/v1/audio/speech',
    shape: 'speech',
    model: 'tts-1',
    note: '音色填 `alloy`/`nova`/`shimmer` 这类；想用 `gpt-4o-mini-tts` 就把服务商切回「自定义」再填。',
  },
  {
    id: 'mimo',
    label: '小米 MiMo（Token Plan · 国内）',
    url: 'https://token-plan-cn.xiaomimimo.com/v1/chat/completions',
    shape: 'chat',
    model: 'mimo-v2.5-tts-voicedesign',
    note: 'Token Plan 专属地址。海外套餐把 `cn` 换成 `sgp` / `ams`，或者切「自定义」自己填。和按量付费**不是一个地址**，混用在那边是 401。',
  },
  {
    id: 'mimo-pay',
    label: '小米 MiMo（按量付费）',
    url: 'https://api.xiaomimimo.com/v1/chat/completions',
    shape: 'chat',
    model: 'mimo-v2.5-tts-voicedesign',
    note: '按量付费走 `api.xiaomimimo.com`。它和 Token Plan 的地址、Key 都不通用——用错了报的是鉴权错，看不出是"选错了计费方式"。',
  },
  {
    id: 'minimax',
    label: 'MiniMax（国内站）',
    url: 'https://api.minimax.chat/v1/t2a_v2',
    shape: 'minimax',
    model: 'speech-02-hd',
    note: '音色填 `voice_id`（如 `male-qn-qingse`）。Key 的域名必须和地址一致：`minimax.chat` 的 Key 只能配这个地址，'
      + '`minimaxi.com` 的 Key 只能配海外站，跨域直接 401。老账号还要填 GroupId（拼在地址后面），新接口可以留空。',
  },
  {
    id: 'minimaxi',
    label: 'MiniMax（海外站）',
    url: 'https://api.minimaxi.com/v1/t2a_v2',
    shape: 'minimax',
    model: 'speech-02-hd',
    note: '同上，只是地址换成 `api.minimaxi.com`——两个站点的 Key 不通用。',
  },
  {
    id: 'dashscope',
    label: '阿里云百炼（按量付费）',
    url: 'https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation',
    shape: 'dashscope',
    model: 'qwen3-tts-flash',
    note: '音色填 `qwen-tts` 的 voice 名（如 `Cherry`）。返回的是音频 URL，枢纽会再下载一次；国际站把域名换成 `dashscope-intl.aliyuncs.com`。',
  },
  {
    id: 'dashscope-plan',
    label: '阿里云百炼（Token Plan）',
    url: 'https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1/audio/speech',
    shape: 'speech',
    model: 'qwen3-tts-flash',
    note: 'Token Plan 走专属 Base URL（`compatible-mode`），和按量付费的 `dashscope.aliyuncs.com` 不通用。兼容模式里若没有 `/audio/speech`，切「自定义」按它文档填路径。',
  },
  {
    id: 'doubao',
    label: '火山引擎（豆包语音）',
    url: 'https://openspeech.bytedance.com/api/v1/tts',
    shape: 'doubao',
    model: '',
    note: '要填 appid（`app.appid`），`apiKey` 当 access token（`app.token`），cluster 默认 `volcano_tts`。'
      + '走方舟那个 `/api/v3/tts` 的账号形状不一样，用「自定义」按它文档填。',
  },
  {
    id: 'plugin',
    label: '第三方插件工具',
    shape: 'plugin',
    url: '',
    model: '',
    note: '枢纽不合成：把插件里的语音工具（如 `voice_tts`）放进模型工具面，模型自己调、再把文件按 `record` 段发出去。',
  },
];

/** 按 id 取预设；认不出的一律当「自定义」，不报错、不静默改用户配置。 */
export const providerOf = (id) => {
  const key = String(id ?? '').trim().toLowerCase();
  return TTS_PROVIDERS.find((p) => p.id === key) ?? TTS_PROVIDERS[0];
};

/** 所有 provider 的 id（schema / 设置页 / 测试共用一份，防漂移）。 */
export const PROVIDER_IDS = TTS_PROVIDERS.map((p) => p.id);
