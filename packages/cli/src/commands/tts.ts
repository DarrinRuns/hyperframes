import { defineCommand } from "citty";
import type { Example } from "./_examples.js";
import { existsSync, readFileSync } from "node:fs";

export const examples: Example[] = [
  ["Generate speech from text", 'hyperframes tts "Welcome to HyperFrames"'],
  ["Choose a voice", 'hyperframes tts "Hello world" --voice am_adam'],
  ["Save to a specific file", 'hyperframes tts "Intro" --voice bf_emma --output narration.wav'],
  ["Adjust speech speed", 'hyperframes tts "Slow and clear" --speed 0.8'],
  [
    "Generate Spanish speech",
    'hyperframes tts "La reunión empieza a las nueve" --voice ef_dora --output es.wav',
  ],
  [
    "Override phonemizer language",
    'hyperframes tts "Ciao a tutti" --voice af_heart --lang it --output accented.wav',
  ],
  ["Read text from a file", "hyperframes tts script.txt"],
  ["List available voices", "hyperframes tts --list"],
  ["Use Gemini TTS (requires GEMINI_API_KEY)", 'hyperframes tts "Hello" --provider gemini'],
  [
    "Gemini with a specific voice",
    'hyperframes tts "Welcome back" --provider gemini --voice Kore --output intro.wav',
  ],
  ["List Gemini voices", "hyperframes tts --list --provider gemini"],
];
import { resolve, extname } from "node:path";
import * as clack from "@clack/prompts";
import { c } from "../ui/colors.js";
import { errorBox } from "../ui/format.js";
import {
  DEFAULT_VOICE,
  BUNDLED_VOICES,
  SUPPORTED_LANGS,
  inferLangFromVoiceId,
  isSupportedLang,
  type SupportedLang,
} from "../tts/manager.js";
import { GEMINI_VOICES, DEFAULT_GEMINI_VOICE } from "../tts/synthesize-gemini.js";

const langList = SUPPORTED_LANGS.join(", ");

export default defineCommand({
  meta: {
    name: "tts",
    description:
      "Generate speech audio from text — local Kokoro-82M (default) or Gemini TTS (--provider gemini)",
  },
  args: {
    input: {
      type: "positional",
      description: "Text to speak, or path to a .txt file",
      required: false,
    },
    output: {
      type: "string",
      description: "Output file path (default: speech.wav in current directory)",
      alias: "o",
    },
    provider: {
      type: "string",
      description: 'TTS provider: "kokoro" (default, local) or "gemini" (requires GEMINI_API_KEY)',
      alias: "p",
    },
    voice: {
      type: "string",
      description: `Voice ID. Kokoro default: ${DEFAULT_VOICE}. Gemini default: ${DEFAULT_GEMINI_VOICE} (also: Kore, Schedar)`,
      alias: "v",
    },
    speed: {
      type: "string",
      description: "Speech speed multiplier 0.1–3.0 (kokoro only, default: 1.0)",
      alias: "s",
    },
    lang: {
      type: "string",
      description: `Phonemizer language — kokoro only, auto-detected from voice prefix. Options: ${langList}`,
      alias: "l",
    },
    list: {
      type: "boolean",
      description: "List available voices and exit",
      default: false,
    },
    json: {
      type: "boolean",
      description: "Output result as JSON",
      default: false,
    },
  },
  async run({ args }) {
    const provider = (args.provider ?? "kokoro") as "kokoro" | "gemini";

    if (provider !== "kokoro" && provider !== "gemini") {
      console.error(c.error(`Unknown provider "${provider}". Use "kokoro" or "gemini".`));
      process.exit(1);
    }

    // ── List voices mode ──────────────────────────────────────────────
    if (args.list) {
      return provider === "gemini" ? listGeminiVoices(args.json) : listVoices(args.json);
    }

    // ── Resolve input text ────────────────────────────────────────────
    if (!args.input) {
      console.error(c.error("Provide text to speak, or use --list to see available voices."));
      process.exit(1);
    }

    let text: string;
    const maybeFile = resolve(args.input);

    if (existsSync(maybeFile) && extname(maybeFile).toLowerCase() === ".txt") {
      text = readFileSync(maybeFile, "utf-8").trim();
      if (!text) {
        console.error(c.error("File is empty."));
        process.exit(1);
      }
    } else {
      text = args.input;
    }

    if (!text.trim()) {
      console.error(c.error("No text provided."));
      process.exit(1);
    }

    // ── Resolve output path ───────────────────────────────────────────
    const output = resolve(args.output ?? "speech.wav");
    const voice = args.voice ?? (provider === "gemini" ? DEFAULT_GEMINI_VOICE : DEFAULT_VOICE);
    const speed = args.speed ? parseFloat(args.speed) : 1.0;

    if (provider === "kokoro" && (isNaN(speed) || speed <= 0 || speed > 3)) {
      console.error(c.error("Speed must be a number between 0.1 and 3.0"));
      process.exit(1);
    }

    let lang: SupportedLang | undefined;
    if (provider === "kokoro") {
      const inferredLang = inferLangFromVoiceId(voice);
      lang = inferredLang;
      if (args.lang != null) {
        const requested = String(args.lang).toLowerCase();
        if (!isSupportedLang(requested)) {
          errorBox("Invalid --lang", `Got "${args.lang}". Must be one of: ${langList}.`);
          process.exit(1);
        }
        lang = requested;
        if (!args.json && lang !== inferredLang) {
          console.log(
            c.dim(
              `  Note: voice "${voice}" is ${inferredLang}, rendering with --lang ${lang} instead.`,
            ),
          );
        }
      }
    } else if (args.lang != null) {
      console.log(c.dim("  Note: --lang is not used with the Gemini provider."));
    }

    // ── Synthesize ────────────────────────────────────────────────────
    const { synthesize } = await import("../tts/synthesize.js");
    const spin = args.json ? null : clack.spinner();
    const spinLabel =
      provider === "gemini"
        ? `Generating speech with Gemini ${c.accent(voice)}...`
        : `Generating speech with ${c.accent(voice)} (${lang})...`;
    spin?.start(spinLabel);

    try {
      const result = await synthesize(text, output, {
        provider,
        voice,
        speed: provider === "kokoro" ? speed : undefined,
        lang: provider === "kokoro" ? lang : undefined,
        onProgress: spin ? (msg) => spin.message(msg) : undefined,
      });

      if (args.json) {
        console.log(
          JSON.stringify({
            ok: true,
            provider,
            voice,
            ...(provider === "kokoro" ? { speed, lang, langApplied: result.langApplied } : {}),
            durationSeconds: result.durationSeconds,
            outputPath: result.outputPath,
          }),
        );
      } else {
        spin?.stop(
          c.success(
            `Generated ${c.accent(result.durationSeconds.toFixed(1) + "s")} of speech → ${c.accent(result.outputPath)}`,
          ),
        );
        if (provider === "kokoro" && args.lang != null && !result.langApplied) {
          console.log(
            c.dim(
              "  Note: installed kokoro-onnx version does not support the --lang kwarg; phonemization used Kokoro's default.",
            ),
          );
        }
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // fallow-ignore-next-line code-duplication
      if (args.json) {
        console.log(JSON.stringify({ ok: false, error: message }));
      } else {
        spin?.stop(c.error(`Speech synthesis failed: ${message}`));
      }
      process.exit(1);
    }
  },
});

// ---------------------------------------------------------------------------
// List voices
// ---------------------------------------------------------------------------

function listVoices(json: boolean): void {
  const rows = BUNDLED_VOICES.map((v) => ({ ...v, defaultLang: inferLangFromVoiceId(v.id) }));

  if (json) {
    console.log(JSON.stringify(rows));
    return;
  }

  console.log(`\n${c.bold("Available voices")} (Kokoro-82M)\n`);
  console.log(
    `  ${c.dim("ID")}                ${c.dim("Name")}         ${c.dim("Language")}   ${c.dim("Lang code")}  ${c.dim("Gender")}`,
  );
  console.log(`  ${c.dim("─".repeat(72))}`);
  for (const row of rows) {
    const id = row.id.padEnd(18);
    const label = row.label.padEnd(13);
    const lang = row.language.padEnd(10);
    const code = row.defaultLang.padEnd(10);
    console.log(`  ${c.accent(id)} ${label} ${lang} ${code} ${row.gender}`);
  }
  console.log(
    `\n  ${c.dim("Use any Kokoro voice ID — see https://github.com/thewh1teagle/kokoro-onnx for all 54 voices")}`,
  );
  console.log(
    `  ${c.dim("Override phonemizer with --lang <" + SUPPORTED_LANGS.join("|") + ">")}\n`,
  );
}

// fallow-ignore-next-line complexity
function listGeminiVoices(json: boolean): void {
  if (json) {
    console.log(JSON.stringify(GEMINI_VOICES));
    return;
  }

  console.log(`\n${c.bold("Available voices")} (Gemini TTS)\n`);
  console.log(`  ${c.dim("Voice")}          ${c.dim("Style")}           ${c.dim("Gender")}`);
  console.log(`  ${c.dim("─".repeat(48))}`);
  for (const v of GEMINI_VOICES) {
    const isPreferred = v.id === "Charon" || v.id === "Kore" || v.id === "Schedar";
    const name = v.id.padEnd(14);
    const style = v.style.padEnd(16);
    const line = `  ${c.accent(name)} ${style} ${v.gender}`;
    console.log(isPreferred ? `${line}  ${c.dim("★")}` : line);
  }
  console.log(
    `\n  ${c.dim("★ = preferred voices (Charon, Kore, Schedar)")}\n` +
      `  ${c.dim("Default voice: Charon")}\n` +
      `  ${c.dim("Requires GEMINI_API_KEY — https://aistudio.google.com/apikey")}\n`,
  );
}
