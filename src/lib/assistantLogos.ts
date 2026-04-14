import claudeSrc from "../../assets/claude.svg";
import codexSrc from "../../assets/openai.svg";
import geminiSrc from "../../assets/gemini.svg";
import opencodeSrc from "../../assets/opencode-logo-dark.svg";
import kiloSrc from "../../assets/kilo.svg";

export const assistantLogoSrc: Record<string, string> = {
  claude: claudeSrc,
  codex: codexSrc,
  gemini: geminiSrc,
  opencode: opencodeSrc,
  kilo: kiloSrc,
};

const MONO_ASSISTANT_LOGOS = new Set(["codex", "opencode"]);

export function getAssistantLogoClass(assistantId: string): string | undefined {
  return MONO_ASSISTANT_LOGOS.has(assistantId) ? "themed-mono-logo" : undefined;
}
