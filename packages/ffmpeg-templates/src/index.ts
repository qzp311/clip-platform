import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export interface FfmpegTemplate {
  templateId: string;
  name: string;
  video?: {
    ratio?: string;
    width?: number;
    height?: number;
    cropMode?: string;
  };
  encode?: {
    codec?: string;
    preset?: string;
    cq?: number;
  };
  audio?: {
    codec?: string;
    bitrate?: string;
  };
  post?: {
    head?: string;
    tail?: string;
    subtitleStyle?: string;
    bgm?: string;
    bgmVolume?: number;
    subtitle?: boolean;
  };
  limits?: {
    maxDurationSec?: number;
  };
}

const templatesDir = join(dirname(fileURLToPath(import.meta.url)), "../templates");

export function listTemplates(): FfmpegTemplate[] {
  return readdirSync(templatesDir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => loadTemplate(f.replace(/\.json$/, "")));
}

export function loadTemplate(templateId: string): FfmpegTemplate {
  const path = join(templatesDir, `${templateId}.json`);
  return JSON.parse(readFileSync(path, "utf-8")) as FfmpegTemplate;
}
