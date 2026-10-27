/**
 * 语音合成的各家用例（`tts.provider` 那个下拉的内容）。
 *
 * 为什么是"预设"而不是"适配器类"：这五家的差异**几乎全在请求体与返回形状**上，而
 * 形状本来就已经是 `tts.shape` 这个可配项了。所以这里只登记三样东西——地址、形状、
 * 模型的默认名——选了下拉就等于把这三项填好，**每一项仍然可改**（自建中转、同一家的
 * 不同区域、改名后的模型，都靠这份"可改"活着）。
 *
 * 地址是**完整**地址，不拼路径：MiMo 把 TTS 挂在 `chat/completions` 上（`m29304` 的
 * 真机证据：`/audio/speech` 在那边是 404），百炼挂在 `multimodal-generation` 上，
 * 没有任何一条共同的尾巴可以拼。
 */

/** 形状 → 一句话说明（设置页提示用，也解释给用户听）。 */
export const SHAPE_HINTS = {
  speech: 'OpenAI `input`/`voice`/`response_format` 那一套，返回二进制音频',
  chat: '把要读的话当成 `assistant` 消息（小米 MiMo）',
  minimax: '`text` + `voice_setting`/`audio_setting`，返回 hex 编码的音频',
  dashscope: '`input:{text,voice}`，返回音频 URL',
  ark: '`model`/`text`/`voice` 平铺，返回 base64 或 URL',
  plugin: '不自己合成：交给第三方插件的工具，模型自己调',
};

/** 所有形状的 id（schema / 测试共用一份，防漂移）。 */
export const SHAPE_IDS = Object.keys(SHAPE_HINTS);

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
    model: '',
    note: '模型名填 `tts-1` 或 `gpt-4o-mini-tts`；音色填 `alloy`/`nova`/`shimmer` 这类。',
  },
  {
    id: 'mimo',
    label: '小米 MiMo',
    url: 'https://token-plan-cn.xiaomimimo.com/v1/chat/completions',
    shape: 'chat',
    model: 'mimo-v2.5-tts-voicedesign',
    note: '走 chat/completions；`voicedesign` 那类模型可以用「音色提示」描述声音，也可以直接给音色。',
  },
  {
    id: 'minimax',
    label: 'MiniMax',
    url: 'https://api.minimax.chat/v1/t2a_v2',
    shape: 'minimax',
    model: 'speech-02-hd',
    note: '音色填 `voice_id`（如 `male-qn-qingse`）。返回 hex；要 URL 就在上游文档里换 `output_format`。海外端点把域名换成 `api.minimaxi.com`。',
  },
  {
    id: 'dashscope',
    label: '阿里云百炼（qwen-tts）',
    url: 'https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation',
    shape: 'dashscope',
    model: 'qwen3-tts-flash',
    note: '音色填 `qwen-tts` 的 voice 名（如 `Cherry`）。返回的是音频 URL，枢纽会再下载一次。',
  },
  {
    id: 'ark',
    label: '火山方舟',
    url: 'https://ark.cn-beijing.volces.com/api/v3/tts',
    shape: 'ark',
    model: '',
    note: '模型名与音色按方舟控制台里那个 TTS 推理接入点填；返回里没有音频时，错误会列出实际收到的字段。',
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
