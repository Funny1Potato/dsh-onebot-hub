/**
 * 语音合成的各家用例（`tts.provider` 那个下拉的内容）。
 *
 * 为什么是"预设"而不是"适配器类"：这五家的差异**几乎全在请求体与返回形状**上，而
 * 形状本来就已经是 `tts.shape` 这个可配项了。所以这里只登记三样东西——地址、形状、
 * 模型的默认名——选了下拉就等于把这三项填好；想手填就把服务商切回 `自定义`（`m29830`：
 * 上一版是"显式优先"，结果切了服务商之后手填的旧值还在偷偷生效，设置页却看不见它们）。
 *
 * 地址是**完整**地址，不拼路径：MiMo 把 TTS 挂在 `chat/completions` 上（`m29304` 的
 * 真机证据：`/audio/speech` 在那边是 404），没有任何一条共同的尾巴可以拼。
 */

/** 形状 → 一句话说明（设置页提示用，也解释给用户听）。 */
export const SHAPE_HINTS = {
  speech: 'OpenAI `input`/`voice`/`response_format` 那一套，返回二进制音频',
  chat: '把要读的话当成 `assistant` 消息（小米 MiMo）',
  minimax: '`text` + `voice_setting`/`audio_setting`，返回 hex 编码的音频（老账号要拼 `?GroupId=`）',
  doubao: '`app`/`user`/`audio`/`request` 四段（豆包语音 V1），`Authorization: Bearer; token`，返回 base64',
  ark: '`req_params:{text,speaker,audio_params}` + `X-Api-Key`/`X-Api-Resource-Id`，返回分块 JSON 流（方舟 Agent Plan）',
  plugin: '不自己合成：交给第三方插件的工具，模型自己调',
};

/** 所有形状的 id（schema / 测试共用一份，防漂移）。 */
export const SHAPE_IDS = Object.keys(SHAPE_HINTS);

/**
 * 这次请求到底打哪儿（`m29830` / `m30480`）：**地址与形状**由服务商决定，`custom` 才用用户填的；
 * **模型**不一样——每家都能换（同一家常有 hd/turbo、voicedesign/tts 这些档），所以永远
 * "用户填的 || 预设默认"。`resourceId` 同理（方舟默认 `seed-tts-2.0`，换声音复刻模型时才改）。
 *
 * 为什么地址不能也这样：地址和服务商是一体的（小米 Token Plan 与按量付费是两个域名、
 * 两套 Key），让用户留着旧地址就是"看不见的配置在管事"。模型则可以安全地只换字号。
 */
export const resolveTtsTarget = ({ provider, url, shape, model, resourceId } = {}) => {
  const preset = providerOf(provider);
  const typedModel = String(model ?? '').trim();
  const typedResource = String(resourceId ?? '').trim();
  if (preset.id !== 'custom') {
    return {
      provider: preset.id,
      url: preset.url || '',
      shape: preset.shape || 'speech',
      model: typedModel || preset.model || '',
      resourceId: typedResource || preset.resourceId || '',
    };
  }
  const shapeId = String(shape ?? '').trim().toLowerCase();
  return {
    provider: 'custom',
    url: String(url ?? '').trim(),
    shape: SHAPE_IDS.includes(shapeId) ? shapeId : 'speech',
    resourceId: typedResource,
    model: typedModel,
  };
};

export const TTS_PROVIDERS = [
  {
    id: 'custom',
    label: '自定义（下面自己填）',
    fields: [],
    url: '',
    shape: '',
    model: '',
    note: '地址、形状、模型全自己填。自建中转、私有部署都走这条。',
  },
  {
    id: 'openai',
    label: 'OpenAI 官方',
    fields: [],
    url: 'https://api.openai.com/v1/audio/speech',
    shape: 'speech',
    model: 'tts-1',
    note: '音色填 `alloy`/`nova`/`shimmer` 这类；想用 `gpt-4o-mini-tts` 就把服务商切回「自定义」再填。',
  },
  {
    id: 'mimo',
    label: '小米 MiMo（Token Plan · 国内）',
    fields: [],
    url: 'https://token-plan-cn.xiaomimimo.com/v1/chat/completions',
    shape: 'chat',
    model: 'mimo-v2.5-tts',
    note: 'Token Plan 专属地址。三个模型：`mimo-v2.5-tts`（内置音色，填冰糖/茉莉/mimo_default 这类）、`mimo-v2.5-tts-voicedesign`（音色描述填在「音色」里，会变成 user 消息）、`mimo-v2.5-tts-voiceclone`（改填参考音频）。海外套餐把 `cn` 换成 `sgp` / `ams`。',
  },
  {
    id: 'mimo-pay',
    label: '小米 MiMo（按量付费）',
    fields: [],
    url: 'https://api.xiaomimimo.com/v1/chat/completions',
    shape: 'chat',
    model: 'mimo-v2.5-tts',
    note: '按量付费走 `api.xiaomimimo.com`（官方文档就是这个域）。它和 Token Plan 的地址、Key 都不通用——用错了报的是鉴权错，看不出是"选错了计费方式"。模型可填 `mimo-v2.5-tts` / `-voicedesign` / `-voiceclone`。',
  },
  {
    id: 'minimax',
    label: 'MiniMax（国内站）',
    fields: ['groupId'],
    url: 'https://api.minimax.chat/v1/t2a_v2',
    shape: 'minimax',
    model: 'speech-02-hd',
    note: '音色填 `voice_id`（如 `male-qn-qingse`）。Key 的域名必须和地址一致：`minimax.chat` 的 Key 只能配这个地址，'
      + '`minimaxi.com` 的 Key 只能配海外站，跨域直接 401。老账号还要填 GroupId（拼在地址后面），新接口可以留空。',
  },
  {
    id: 'minimaxi',
    label: 'MiniMax（海外站）',
    fields: ['groupId'],
    url: 'https://api.minimaxi.com/v1/t2a_v2',
    shape: 'minimax',
    model: 'speech-02-hd',
    note: '同上，只是地址换成 `api.minimaxi.com`——两个站点的 Key 不通用。',
  },
  {
    id: 'ark',
    label: '火山方舟（Agent Plan）',
    fields: ['resourceId'],
    url: 'https://openspeech.bytedance.com/api/v3/plan/tts/unidirectional',
    shape: 'ark',
    model: '',
    resourceId: 'seed-tts-2.0',
    note: 'Agent Plan 的专属 API Key 填在 `apiKey`（走 `X-Api-Key`），`X-Api-Resource-Id` 默认 `seed-tts-2.0`。音色填 `speaker`（如 `zh_female_vv_uranus_bigtts`）。这是**另一套凭据**，和豆包语音 V1 的 appid/token 不通用。',
  },
  {
    id: 'doubao',
    label: '火山引擎（豆包语音 V1）',
    fields: ['appId', 'cluster'],
    url: 'https://openspeech.bytedance.com/api/v1/tts',
    shape: 'doubao',
    model: '',
    note: '要填 appid（`app.appid`），`apiKey` 当 access token（`app.token`），cluster 默认 `volcano_tts`。'
      + 'Agent Plan 那套（`/api/v3/plan/tts/...`）是另一条，选上面那条。',
  },
  {
    id: 'plugin',
    label: '第三方插件工具',
    fields: [],
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

/**
 * 每家"额外要用"的配置项（设置页据此只显示这一家真正用得上的那几格，`m30480`：
 * 选了消息里写着"选谁都要看七八个跟自己无关的框"，那是把选择成本又还给了用户）。
 * 键名对应 `tts.*` 的后半段；没列的（appId/cluster/groupId/resourceId 之外）都是通用的。
 */
export const PROVIDER_FIELDS = Object.fromEntries(
  TTS_PROVIDERS.map((preset) => [preset.id, [...(preset.fields || [])]]),
);

/** 某家额外要用哪几格（认不出的服务商当 custom：全都给，免得手填的人没处填）。 */
export const providerFieldsOf = (id) => PROVIDER_FIELDS[providerOf(id).id] || [];
