import { readFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { RawAsrSegment } from "@clip/sdk";

const fixturePath = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../../../../fixtures/mock-raw-asr.json",
);

export async function transcribeWithMock(
  _audioPath: string,
): Promise<{ rawSegments: RawAsrSegment[]; durationMs: number }> {
  const rawSegments = JSON.parse(await readFile(fixturePath, "utf-8")) as RawAsrSegment[];
  return {
    rawSegments,
    durationMs: rawSegments.at(-1)?.endMs ?? 0,
  };
}
