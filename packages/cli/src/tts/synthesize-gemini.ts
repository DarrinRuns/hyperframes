import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

// ---------------------------------------------------------------------------
// Voice catalogue — Gemini prebuilt voices
// Charon, Kore, and Schedar are the preferred defaults for narration work.
// ---------------------------------------------------------------------------

export interface GeminiVoiceInfo {
  id: string;
  label: string;
  gender: "female" | "male";
  style: string;
}

export const GEMINI_VOICES: GeminiVoiceInfo[] = [
  // Preferred voices
  { id: "Charon", label: "Charon", gender: "male", style: "Informative" },
  { id: "Kore", label: "Kore", gender: "female", style: "Firm" },
  { id: "Schedar", label: "Schedar", gender: "male", style: "Even" },
  // Extended catalogue
  { id: "Puck", label: "Puck", gender: "male", style: "Upbeat" },
  { id: "Fenrir", label: "Fenrir", gender: "male", style: "Excitable" },
  { id: "Aoede", label: "Aoede", gender: "female", style: "Breezy" },
  { id: "Leda", label: "Leda", gender: "female", style: "Youthful" },
  { id: "Zephyr", label: "Zephyr", gender: "female", style: "Bright" },
  { id: "Enceladus", label: "Enceladus", gender: "male", style: "Breathy" },
  { id: "Iapetus", label: "Iapetus", gender: "male", style: "Clear" },
  { id: "Gacrux", label: "Gacrux", gender: "male", style: "Mature" },
  { id: "Achernar", label: "Achernar", gender: "female", style: "Soft" },
  { id: "Alnilam", label: "Alnilam", gender: "male", style: "Firm" },
  { id: "Sulafat", label: "Sulafat", gender: "male", style: "Warm" },
  { id: "Orbit", label: "Orbit", gender: "male", style: "Relaxed" },
];

export const DEFAULT_GEMINI_VOICE = "Charon";

// Model ID — override via HYPERFRAMES_GEMINI_TTS_MODEL env var
const DEFAULT_GEMINI_TTS_MODEL = "gemini-2.5-flash-preview-tts";

// ---------------------------------------------------------------------------
// PCM → WAV conversion
// Gemini TTS returns raw 16-bit signed PCM at 24 kHz mono.
// We wrap it in a standard RIFF/WAV header so any audio tool can read it.
// ---------------------------------------------------------------------------

const SAMPLE_RATE = 24_000;
const CHANNELS = 1;
const BITS_PER_SAMPLE = 16;

function buildWavBuffer(pcmData: Buffer): Buffer {
  const byteRate = SAMPLE_RATE * CHANNELS * (BITS_PER_SAMPLE / 8);
  const blockAlign = CHANNELS * (BITS_PER_SAMPLE / 8);
  const dataSize = pcmData.length;

  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + dataSize, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16); // PCM fmt chunk size
  header.writeUInt16LE(1, 20); // AudioFormat = PCM
  header.writeUInt16LE(CHANNELS, 22);
  header.writeUInt32LE(SAMPLE_RATE, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(BITS_PER_SAMPLE, 34);
  header.write("data", 36);
  header.writeUInt32LE(dataSize, 40);

  return Buffer.concat([header, pcmData]);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface GeminiSynthesizeOptions {
  voice?: string;
  model?: string;
  onProgress?: (message: string) => void;
}

export interface GeminiSynthesizeResult {
  outputPath: string;
  sampleRate: number;
  durationSeconds: number;
  langApplied: boolean;
}

/**
 * Synthesize text to speech using Gemini TTS via the Google GenAI API.
 * Requires GEMINI_API_KEY or GOOGLE_API_KEY in the environment.
 *
 * Inline audio tags (e.g. [short pause], [excited]) are supported by the
 * model and can be embedded directly in the text.
 */
// fallow-ignore-next-line complexity
export async function synthesizeGemini(
  text: string,
  outputPath: string,
  options?: GeminiSynthesizeOptions,
): Promise<GeminiSynthesizeResult> {
  const apiKey = process.env.GEMINI_API_KEY ?? process.env.GOOGLE_API_KEY;
  if (!apiKey) {
    throw new Error(
      "Gemini TTS requires GEMINI_API_KEY or GOOGLE_API_KEY. " +
        "Get a key at https://aistudio.google.com/apikey",
    );
  }

  const voice = options?.voice ?? DEFAULT_GEMINI_VOICE;
  const model =
    options?.model ?? process.env.HYPERFRAMES_GEMINI_TTS_MODEL ?? DEFAULT_GEMINI_TTS_MODEL;

  options?.onProgress?.(`Requesting speech from Gemini (${voice})...`);

  const { GoogleGenAI } = await import("@google/genai");
  const ai = new GoogleGenAI({ apiKey });

  const response = await ai.models.generateContent({
    model,
    contents: [{ parts: [{ text }] }],
    config: {
      responseModalities: ["AUDIO"],
      speechConfig: {
        voiceConfig: {
          prebuiltVoiceConfig: { voiceName: voice },
        },
      },
    },
  });

  const inlineData = response.candidates?.[0]?.content?.parts?.[0]?.inlineData;
  if (!inlineData?.data) {
    throw new Error(
      "Gemini TTS returned no audio data. " +
        "Verify your API key has TTS access and the model is available in your region.",
    );
  }

  const pcmBuffer = Buffer.from(inlineData.data, "base64");
  const wavBuffer = buildWavBuffer(pcmBuffer);

  options?.onProgress?.("Writing audio file...");
  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, wavBuffer);

  const durationSeconds = pcmBuffer.length / (SAMPLE_RATE * CHANNELS * (BITS_PER_SAMPLE / 8));

  return {
    outputPath,
    sampleRate: SAMPLE_RATE,
    durationSeconds: Math.round(durationSeconds * 1000) / 1000,
    langApplied: true,
  };
}
