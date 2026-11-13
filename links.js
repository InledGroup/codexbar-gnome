// Per-provider links used by the popup footer and the About dialog.
//
// The URL map is adapted from lhw/codexbar-gnome (MIT). Keys match the ids
// codexbar emits from `config providers` and `usage`, not the --provider flag
// spelling where the two differ.

export const USAGE_URLS = {
  codex: "https://chatgpt.com/codex/settings/usage",
  openai: "https://platform.openai.com/usage",
  azureopenai: "https://portal.azure.com/",
  claude: "https://claude.ai/settings/usage",
  clinepass: "https://cline.bot/usage",
  cursor: "https://cursor.com/dashboard/usage",
  opencode: "https://opencode.ai/console",
  opencodego: "https://opencode.ai/console/go/status",
  alibaba: "https://bailian.console.aliyun.com/",
  alibabatokenplan: "https://bailian.console.aliyun.com/",
  qwencloud: "https://bailian.console.aliyun.com/",
  factory: "https://app.factory.ai/cli",
  fireworks: "https://fireworks.ai/account/billing",
  gemini: "https://aistudio.google.com/",
  antigravity: "https://antigravity.google/",
  copilot: "https://github.com/settings/billing/budgets",
  devin: "https://devin.ai/usage",
  zai: "https://z.ai/manage-apikey/apikey-list",
  minimax: "https://platform.minimax.io/user-center/basic-information/interface-key",
  manus: "https://manus.im/",
  kimi: "https://platform.moonshot.cn/console/api-keys",
  kilo: "https://app.kilo.ai/",
  kiro: "https://kiro.dev/",
  vertexai: "https://console.cloud.google.com/",
  augment: "https://app.augmentcode.com/",
  jetbrains: "https://www.jetbrains.com/ai/",
  moonshot: "https://platform.moonshot.cn/",
  amp: "https://ampcode.com/settings",
  t3chat: "https://t3.chat/",
  langdock: "https://langdock.com/",
  ollama: "https://ollama.com/settings/keys",
  synthetic: "https://platform.synthetic.new/",
  openrouter: "https://openrouter.ai/credits",
  elevenlabs: "https://elevenlabs.io/app/settings/usage",
  warp: "https://warp.dev/account",
  windsurf: "https://windsurf.com/usage",
  zed: "https://zed.dev/account",
  perplexity: "https://www.perplexity.ai/settings/usage",
  mimo: "https://platform.xiaomimimo.com/",
  doubao: "https://console.volcengine.com/ark/region:ark+cn-beijing/home",
  sakana: "https://sakana.ai/",
  abacus: "https://abacus.ai/",
  mistral: "https://console.mistral.ai/workspace/limits",
  deepseek: "https://platform.deepseek.com/usage",
  deepinfra: "https://deepinfra.com/dash/api_keys",
  codebuff: "https://www.codebuff.com/",
  venice: "https://venice.ai/",
  commandcode: "https://app.commandcode.com/",
  qoder: "https://qoder.com/",
  stepfun: "https://platform.stepfun.com/",
  bedrock: "https://console.aws.amazon.com/bedrock/home",
  grok: "https://console.x.ai/",
  xai: "https://console.x.ai/",
  groq: "https://console.groq.com/keys",
  litellm: "https://cloud.litellm.ai/",
  poe: "https://poe.com/",
  muse: "https://muse.ai/",
  coderabbit: "https://coderabbit.ai/",
  replicate: "https://replicate.com/account/billing",
  huggingface: "https://huggingface.co/settings/billing",
  raycast: "https://www.raycast.com/dashboard",
  pi: "https://pi.ai/",
  v0: "https://v0.dev/chat/settings/usage",
};

export const STATUS_URLS = {
  codex: "https://status.openai.com/",
  openai: "https://status.openai.com/",
  azureopenai: "https://azure.status.microsoft/en-us/status",
  claude: "https://status.claude.com/",
  cursor: "https://status.cursor.com/",
  opencode: "https://status.opencode.ai/",
  opencodego: "https://status.opencode.ai/",
  gemini: "https://status.cloud.google.com/",
  copilot: "https://www.githubstatus.com/",
  deepseek: "https://status.deepseek.com/",
  zai: "https://status.z.ai/",
  kimi: "https://status.moonshot.cn/",
  grok: "https://status.x.ai/",
  xai: "https://status.x.ai/",
  groq: "https://status.groq.com/",
  replicate: "https://status.replicate.com/",
  elevenlabs: "https://status.elevenlabs.io/",
  ollama: "https://status.ollama.com/",
  openrouter: "https://status.openrouter.ai/",
  v0: "https://www.vercel-status.com/",
  devin: "https://status.devin.ai/",
  windsurf: "https://status.windsurf.com/",
};

export const INSTALL_URL = "https://github.com/steipete/CodexBar#installation";
export const EXTENSION_REPO_URL =
  "https://github.com/InledGroup/codexbar-gnome";
export const CLI_REPO_URL = "https://github.com/steipete/CodexBar";
export const LICENSE_URL = "https://license.inled.es";
export const EGO_URL = "https://extensions.gnome.org/extension/9841/codexbar/";

const FALLBACK_URL = "https://codexbar.app";

export function usageUrl(providerId) {
  return USAGE_URLS[providerId] || FALLBACK_URL;
}

export function statusUrl(providerId) {
  return STATUS_URLS[providerId] || FALLBACK_URL;
}
