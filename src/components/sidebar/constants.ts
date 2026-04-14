import type { CodingAssistant } from "../../lib/types";

export const CODING_ASSISTANTS: CodingAssistant[] = [
  { id: "claude", name: "Claude Code", command: "claude", yoloFlag: "--dangerously-skip-permissions" },
  { id: "codex", name: "Codex", command: "codex", yoloFlag: "--full-auto" },
  { id: "gemini", name: "Gemini", command: "gemini", yoloFlag: null },
  { id: "opencode", name: "Open Code", command: "opencode", yoloFlag: null },
  { id: "kilo", name: "Kilo", command: "kilo", yoloFlag: null },
];

export const ASSISTANT_INSTALL_URLS: Record<string, string> = {
  claude: "https://code.claude.com/docs/en/overview",
  codex: "https://github.com/openai/codex",
  gemini: "https://github.com/google-gemini/gemini-cli",
  opencode: "https://opencode.ai/",
  kilo: "https://kilo.ai/cli",
};
