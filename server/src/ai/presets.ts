/**
 * 模型服务商预设（P4-01）：降低用户配置门槛。
 * 注意：sk-sp- 套餐 Key 与通用 Key 的 Base URL 完全隔离，混用报 invalid_api_key，
 * 预设文案必须显式说明配对关系（验证记录 P1-05）。
 */

export interface ModelPreset {
  id: string;
  name: string;
  baseUrl: string;
  /** 推荐模型（用户可改） */
  models: string[];
  /** Key 获取入口（展示给用户，服务端不代跳） */
  keyUrl: string;
  /** 配置指引（中文） */
  guide: string;
  /** 配置指引（英文） */
  guideEn: string;
}

export const MODEL_PRESETS: readonly ModelPreset[] = [
  {
    id: 'kimi-cn',
    name: 'Kimi（Moonshot 国内站）',
    baseUrl: 'https://api.moonshot.cn/v1',
    models: ['kimi-k2.7-code', 'kimi-k2.6', 'moonshot-v1-128k'],
    keyUrl: 'https://platform.moonshot.cn/console/api-keys',
    guide: '在 platform.moonshot.cn 控制台创建 API Key（sk- 开头）。注意：国内站与国际站（api.moonshot.ai）账号和 Key 不通用，配错站点会报 401。',
    guideEn: 'Create an API key (sk-...) at platform.moonshot.cn. The CN site and the global site (api.moonshot.ai) use separate accounts and keys; mixing them returns 401.',
  },
  {
    id: 'kimi-global',
    name: 'Kimi（Moonshot 国际站）',
    baseUrl: 'https://api.moonshot.ai/v1',
    models: ['kimi-k2.7-code', 'kimi-k2.6'],
    keyUrl: 'https://platform.moonshot.ai/console/api-keys',
    guide: '在 platform.moonshot.ai 控制台创建 API Key。与国内站（api.moonshot.cn）Key 不通用。',
    guideEn: 'Create an API key at platform.moonshot.ai. Not interchangeable with the CN site (api.moonshot.cn).',
  },
  {
    id: 'bailian',
    name: '阿里云百炼（按量付费）',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    models: ['qwen3-coder-plus', 'qwen3.7-plus', 'qwen-plus'],
    keyUrl: 'https://bailian.console.aliyun.com/settings/api-key',
    guide: '在百炼控制台「API-KEY」页创建通用 Key（sk- 开头，无 sk-sp- 前缀）。若你的 Key 以 sk-sp- 开头，请改用下方对应的套餐预设，混用会报 invalid_api_key。',
    guideEn: 'Create a standard key (sk-..., without the sk-sp- prefix) on the Bailian console API-KEY page. If your key starts with sk-sp-, use the matching plan preset below instead — mixing them returns invalid_api_key.',
  },
  {
    id: 'bailian-coding-plan',
    name: '阿里云百炼 Coding Plan',
    baseUrl: 'https://coding.dashscope.aliyuncs.com/v1',
    models: ['qwen3-coder-plus'],
    keyUrl: 'https://bailian.console.aliyun.com/cn-beijing/subscription/coding-plan',
    guide: 'Coding Plan 专属 Key（sk-sp- 开头）在控制台「我的订阅 · Coding Plan」获取，必须搭配本专属地址，不能用按量付费地址。',
    guideEn: 'Coding Plan keys (sk-sp-...) are issued under "My Subscriptions · Coding Plan" and must be paired with this dedicated base URL, not the pay-as-you-go one.',
  },
  {
    id: 'bailian-token-plan',
    name: '阿里云百炼 Token Plan（团队版）',
    baseUrl: 'https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1',
    models: ['kimi-k2.7-code', 'qwen3.7-plus', 'deepseek-v4-pro'],
    keyUrl: 'https://bailian.console.aliyun.com/cn-beijing/subscription',
    guide: 'Token Plan 专属 Key（sk-sp- 开头）在控制台「我的订阅」API Key 区域获取（仅创建时完整显示一次），必须搭配本专属地址。可用模型以你的订阅为准。',
    guideEn: 'Token Plan keys (sk-sp-...) are issued under "My Subscriptions" (shown in full only once at creation) and must be paired with this dedicated base URL. Available models depend on your subscription.',
  },
  {
    id: 'custom',
    name: '自定义 OpenAI 兼容接口',
    baseUrl: '',
    models: [],
    keyUrl: '',
    guide: '填写服务商提供的 OpenAI 兼容 Base URL（通常以 /v1 结尾）、API Key 与模型名。保存后用「测试」验证连接与工具调用能力；不支持工具调用的接口无法执行完整 AI 编程任务。',
    guideEn: 'Enter the OpenAI-compatible base URL (usually ending in /v1), API key, and model name from your provider. Run "Test" after saving to verify connectivity and tool-calling; endpoints without tool-calling cannot run full AI coding tasks.',
  },
];
