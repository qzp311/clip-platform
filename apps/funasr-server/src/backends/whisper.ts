import { readFile } from "node:fs/promises";
import type { RawAsrSegment } from "@clip/sdk";
import { transcribeWithVad } from "./vad.js";

let pipelinePromise: Promise<WhisperPipeline> | null = null;

type WhisperPipeline = (
  audio: Float32Array,
  options: Record<string, unknown>,
) => Promise<{ text: string; chunks?: Array<{ text: string; timestamp: [number, number | null] }> }>;

export async function transcribeWithWhisper(
  audioPath: string,
  options: { ffmpegPath?: string; device?: string } = {},
): Promise<{ rawSegments: RawAsrSegment[]; durationMs: number }> {
  try {
    const { pipeline } = await import("@xenova/transformers");
    if (!pipelinePromise) {
      console.log("[funasr-server] loading whisper model Xenova/whisper-small (first run downloads ~250MB)...");
      pipelinePromise = pipeline("automatic-speech-recognition", "Xenova/whisper-small") as Promise<WhisperPipeline>;
    }
    const transcriber = await pipelinePromise;
    const audio = await loadWavMono16k(audioPath);
    const durationMs = Math.round((audio.length / 16_000) * 1000);

    const result = await transcriber(audio, {
      language: "chinese",
      task: "transcribe",
      return_timestamps: true,
      chunk_length_s: 30,
    });

    const chunks = result.chunks ?? [];
    if (chunks.length === 0 && result.text) {
      return {
        durationMs,
        rawSegments: [
          {
            id: "r001",
            startMs: 0,
            endMs: durationMs,
            text: result.text.trim(),
            confidence: 0.9,
          },
        ],
      };
    }

    const rawSegments: RawAsrSegment[] = chunks
      .filter((chunk) => chunk.text.trim().length > 0)
      .map((chunk, index) => {
        const startSec = chunk.timestamp[0] ?? 0;
        const endSec = chunk.timestamp[1] ?? startSec + 2;
        return {
          id: `r${String(index + 1).padStart(3, "0")}`,
          startMs: Math.round(startSec * 1000),
          endMs: Math.round(endSec * 1000),
          text: chunk.text.trim(),
          confidence: 0.9,
        };
      });

    return { rawSegments, durationMs };
  } catch (err) {
    console.error("[funasr-server] whisper backend failed, falling back to vad:", err);
    return transcribeWithVad(audioPath, { ffmpegPath: options.ffmpegPath });
  }
}

async function loadWavMono16k(audioPath: string): Promise<Float32Array> {
  const buffer = await readFile(audioPath);
  if (buffer.toString("ascii", 0, 4) !== "RIFF") {
    throw new Error("expected 16k mono wav input");
  }

  const channels = buffer.readUInt16LE(22);
  const sampleRate = buffer.readUInt32LE(24);
  const bitsPerSample = buffer.readUInt16LE(34);
  const dataOffset = 44;
  const bytesPerSample = bitsPerSample / 8;
  const sampleCount = Math.floor((buffer.length - dataOffset) / (bytesPerSample * channels));
  const output = new Float32Array(sampleCount);

  for (let i = 0; i < sampleCount; i++) {
    const offset = dataOffset + i * bytesPerSample * channels;
    let sample = 0;
    if (bitsPerSample === 16) {
      sample = buffer.readInt16LE(offset) / 32768;
    } else if (bitsPerSample === 32) {
      sample = buffer.readFloatLE(offset);
    }
    output[i] = sample;
  }

  if (sampleRate === 16_000) return output;
  return resample(output, sampleRate, 16_000);
}

function resample(input: Float32Array, fromRate: number, toRate: number): Float32Array {
  if (fromRate === toRate) return input;
  const ratio = fromRate / toRate;
  const outputLength = Math.floor(input.length / ratio);
  const output = new Float32Array(outputLength);
  for (let i = 0; i < outputLength; i++) {
    const sourceIndex = i * ratio;
    const left = Math.floor(sourceIndex);
    const right = Math.min(left + 1, input.length - 1);
    const weight = sourceIndex - left;
    output[i] = input[left]! * (1 - weight) + input[right]! * weight;
  }
  return output;
}
