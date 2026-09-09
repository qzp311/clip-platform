import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { dataRoot } from "./config.js";

export type MaterialJobStatus = "uploaded" | "processing" | "completed" | "failed";

export interface MaterialJob {
  jobId: string;
  localPath: string;
  taskId: string;
  sourceUrl: string;
  status: MaterialJobStatus;
  outputUrl?: string;
  subtitleUrl?: string;
  totalWallTimeSec?: number;
  error?: string;
  createdAt: string;
  updatedAt: string;
}

function jobsDir(): string {
  return join(dataRoot(), "jobs");
}

function jobPath(jobId: string): string {
  return join(jobsDir(), `${jobId}.json`);
}

export async function saveMaterialJob(job: MaterialJob): Promise<void> {
  await mkdir(jobsDir(), { recursive: true });
  await writeFile(jobPath(job.jobId), JSON.stringify(job, null, 2));
}

export async function updateMaterialJob(
  jobId: string,
  patch: Partial<
    Pick<
      MaterialJob,
      "status" | "outputUrl" | "subtitleUrl" | "totalWallTimeSec" | "error" | "taskId" | "sourceUrl"
    >
  >,
): Promise<MaterialJob | null> {
  const job = await loadMaterialJob(jobId);
  if (!job) return null;
  const next: MaterialJob = {
    ...job,
    ...patch,
    updatedAt: new Date().toISOString(),
  };
  await saveMaterialJob(next);
  return next;
}

export async function loadMaterialJob(jobId: string): Promise<MaterialJob | null> {
  try {
    const raw = await readFile(jobPath(jobId), "utf-8");
    return JSON.parse(raw) as MaterialJob;
  } catch {
    return null;
  }
}

export async function listMaterialJobs(limit = 20): Promise<MaterialJob[]> {
  await mkdir(jobsDir(), { recursive: true });
  const files = (await readdir(jobsDir())).filter((f) => f.endsWith(".json"));
  const jobs: MaterialJob[] = [];
  for (const file of files) {
    try {
      const raw = await readFile(join(jobsDir(), file), "utf-8");
      jobs.push(JSON.parse(raw) as MaterialJob);
    } catch {
      // skip corrupt
    }
  }
  jobs.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  return jobs.slice(0, limit);
}

export function createMaterialJob(input: {
  localPath: string;
  taskId: string;
  sourceUrl: string;
}): MaterialJob {
  const now = new Date().toISOString();
  return {
    jobId: `job-${randomUUID().slice(0, 8)}`,
    localPath: input.localPath,
    taskId: input.taskId,
    sourceUrl: input.sourceUrl,
    status: "uploaded",
    createdAt: now,
    updatedAt: now,
  };
}
