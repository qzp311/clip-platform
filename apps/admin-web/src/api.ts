import { request, requestBlob } from "./api/http.js";
import { getAccessToken } from "./utils/auth.js";

export { ApiAuthError } from "./api/http.js";

const API_PREFIX = "/admin/api";

export interface PageParams {
  limit?: number;
  offset?: number;
}

function pageQuery<T extends PageParams & object>(params?: T): string {
  const q = new URLSearchParams();
  const rec = params as Record<string, unknown> | undefined;
  if (rec?.limit != null) q.set("limit", String(rec.limit));
  if (rec?.offset != null) q.set("offset", String(rec.offset));
  for (const [key, value] of Object.entries(rec ?? {})) {
    if (key === "limit" || key === "offset") continue;
    if (value === undefined || value === "") continue;
    q.set(key, String(value));
  }
  const qs = q.toString();
  return qs ? `?${qs}` : "";
}

export const api = {
  getDailyStats: (params?: PageParams & { date?: string }) =>
    request<{
      date: string;
      devices: Record<string, unknown>[];
      total: number;
      limit: number;
      offset: number;
      summary: { taskCount: number; taskSuccess: number; taskFail: number; deviceCount: number };
    }>(`${API_PREFIX}/stats/devices/daily${pageQuery(params)}`),
  getAgentSummary: (params?: { days?: number }) =>
    request<{
      agents: Array<{
        deviceId: string;
        machineName: string;
        online: boolean;
        taskTotal: number;
        taskSuccess: number;
        taskFail: number;
        running: number;
        successRate: number | null;
        avgWallSec: number | null;
        p50WallSec: number | null;
        p95WallSec: number | null;
        firstSeenAt: string | null;
        lastActiveAt: string | null;
      }>;
    }>(`${API_PREFIX}/stats/agents/summary${params?.days ? `?days=${params.days}` : ""}`),
  getTaskTrend: (params?: { days?: number }) =>
    request<{
      trend: Array<{ day: string; total: number; success: number; fail: number }>;
    }>(`${API_PREFIX}/stats/tasks/trend${params?.days ? `?days=${params.days}` : ""}`),
  listDevices: (params?: PageParams & { q?: string; onlineOnly?: boolean }) =>
    request<{
      devices: Record<string, unknown>[];
      total: number;
      limit: number;
      offset: number;
      stats: { total: number; online: number; agentOff: number };
    }>(`${API_PREFIX}/devices${pageQuery(params)}`),
  getDeviceOverride: (id: string) =>
    request<Record<string, unknown>>(`${API_PREFIX}/devices/${id}/override`),
  updateDeviceOverride: (id: string, body: unknown) =>
    request(`${API_PREFIX}/devices/${id}/config-overrides`, {
      method: "PUT",
      body: JSON.stringify(body),
    }),
  deviceTimeline: (id: string, params?: PageParams & { date?: string }) =>
    request<{
      deviceId: string;
      date: string;
      tasks: Record<string, string>[];
      total: number;
      limit: number;
      offset: number;
      telemetry: unknown[];
    }>(`${API_PREFIX}/stats/devices/${id}/timeline${pageQuery(params)}`),
  listTasks: (params?: PageParams & { status?: string; taskKind?: string; dramaId?: string; deviceId?: string }) =>
    request<{
      tasks: Record<string, unknown>[];
      total: number;
      limit: number;
      offset: number;
      deviceNames?: Record<string, string>;
    }>(`${API_PREFIX}/tasks${pageQuery(params)}`),
  /** 按剧聚合的任务看板 */
  getTaskBoard: (params?: PageParams & { aggStatus?: string; deviceId?: string }) =>
    request<{
      groups: Array<{
        dramaId: string;
        title: string;
        taskCount: number;
        lastActiveAt: string;
        aggStatus: "running" | "completed" | "failed";
        servers: string[];
        failMessage?: string;
        stages: Array<{
          key: string;
          label: string;
          total: number;
          done: number;
          status: "pending" | "running" | "completed" | "failed";
          phase?: string;
          taskId?: string;
          claimedBy?: string;
          claimedAt?: string;
          outputUrl?: string;
        }>;
        episodes: Array<{ episodeNo?: number; status: string; taskId: string; server?: string; elapsed?: number }>;
      }>;
      total: number;
      limit: number;
      offset: number;
      deviceNames?: Record<string, string>;
    }>(`${API_PREFIX}/tasks/board${pageQuery(params)}`),
  getTask: (id: string) => request<Record<string, unknown>>(`${API_PREFIX}/tasks/${id}`),
  listPackageCaches: (params?: PageParams & { dramaId?: string; deviceId?: string; status?: string }) =>
    request<{ items: Record<string, unknown>[]; total: number; limit: number; offset: number }>(`${API_PREFIX}/package-caches${pageQuery(params)}`),
  retryTask: (id: string) =>
    request(`${API_PREFIX}/tasks/${id}/retry`, { method: "POST", body: "{}" }),
  updateDramaPackagePriority: (id: string, priority: boolean) =>
    request<{ ok: boolean; task: Record<string, unknown> }>(`${API_PREFIX}/tasks/${id}/priority`, {
      method: "PATCH",
      body: JSON.stringify({ priority }),
    }),
  updatePlan: (id: string, plan: unknown) =>
    request(`${API_PREFIX}/tasks/${id}/plan`, { method: "PUT", body: JSON.stringify(plan) }),
  createTask: (body: unknown) =>
    request(`${API_PREFIX}/tasks`, { method: "POST", body: JSON.stringify(body) }),
  createDramaPackage: (body: unknown) =>
    request<Record<string, unknown>>(`${API_PREFIX}/drama-packages`, {
      method: "POST",
      body: JSON.stringify(body),
    }),
  getDramaPackageTosUploadPolicy: (body: { title: string; filename: string }) =>
    request<{
      ok: boolean;
      uploadUrl: string;
      objectKey: string;
      sourceUrl: string;
      packageName: string;
      dedupSeq: number;
      expiresSec: number;
      contentType: string;
    }>(`${API_PREFIX}/drama-packages/tos-upload-policy`, {
      method: "POST",
      body: JSON.stringify(body),
    }),
  getMediaTosUploadPolicy: (body: { title: string; filename: string }) =>
    request<{
      ok: boolean;
      uploadUrl: string;
      objectKey: string;
      sourceUrl: string;
      filename: string;
      expiresSec: number;
      contentType: string;
    }>(`${API_PREFIX}/media/tos-upload-policy`, {
      method: "POST",
      body: JSON.stringify(body),
    }),
  resetDemo: () => request(`${API_PREFIX}/tasks/reset-demo`, { method: "POST", body: "{}" }),
  getGlobalConfig: () => request<Record<string, unknown>>(`${API_PREFIX}/config/global`),
  updateGlobalConfig: (body: unknown) =>
    request(`${API_PREFIX}/config/global`, { method: "PUT", body: JSON.stringify(body) }),
  listRuleSets: (params?: PageParams) =>
    request<{ ruleSets: Record<string, unknown>[]; total: number; limit: number; offset: number }>(
      `${API_PREFIX}/asr-rule-sets${pageQuery(params)}`,
    ),
  getRuleSet: (id: string) => request<Record<string, unknown>>(`${API_PREFIX}/asr-rule-sets/${id}`),
  updateRuleSet: (id: string, body: unknown) =>
    request(`${API_PREFIX}/asr-rule-sets/${id}`, { method: "PUT", body: JSON.stringify(body) }),
  listDramas: (params?: PageParams) =>
    request<{ dramas: Record<string, unknown>[]; total: number; limit: number; offset: number }>(
      `${API_PREFIX}/dramas${pageQuery(params)}`,
    ),
  bindDrama: (id: string, asrRuleSetId: string) =>
    request(`${API_PREFIX}/dramas/${id}/asr-rule-set`, {
      method: "PUT",
      body: JSON.stringify({ asrRuleSetId }),
    }),
  updateDramaMeta: (id: string, body: { synopsis?: string; genreTags?: string[]; plotThreads?: string[] }) =>
    request(`${API_PREFIX}/dramas/${id}/meta`, { method: "PUT", body: JSON.stringify(body) }),
  listDramaIntake: (params?: PageParams & { status?: string; dramaType?: string; externalDramaId?: string; q?: string }) =>
    request<{
      items: Record<string, unknown>[];
      total: number;
      limit: number;
      offset: number;
      statusCounts?: Record<string, number>;
    }>(`${API_PREFIX}/drama-intake${pageQuery(params)}`),
  listDramaIntakeDownloaded: (params?: PageParams & { dramaType?: string; externalDramaId?: string; q?: string }) =>
    request<{
      items: Record<string, unknown>[];
      total: number;
      limit: number;
      offset: number;
      statusCounts?: Record<string, number>;
    }>(`${API_PREFIX}/drama-intake/downloaded${pageQuery(params)}`),
  batchCreateDramaIntake: (
    items: Array<{ title: string; externalDramaId: string; dramaType: string }>,
  ) =>
    request<{
      ok: boolean;
      created: Record<string, unknown>[];
      duplicates: string[];
      autoQueued?: Array<{ externalDramaId: string; taskId: string; sourceUrl: string }>;
      errors?: Array<{ line: number; error: string }>;
    }>(`${API_PREFIX}/drama-intake/batch`, {
      method: "POST",
      body: JSON.stringify({ items }),
    }),
  updateDramaIntake: (
    id: string,
    body: {
      status?: string;
      dramaType?: string;
      synopsis?: string | null;
      note?: string | null;
      linkedTaskId?: string | null;
      linkedDramaId?: string | null;
    },
  ) =>
    request<{ ok: boolean; item: Record<string, unknown> }>(`${API_PREFIX}/drama-intake/${id}`, {
      method: "PATCH",
      body: JSON.stringify(body),
    }),
  updateDramaIntakeSynopsis: (externalDramaId: string, synopsis: string) =>
    request<{ ok: boolean; item: Record<string, unknown> }>(`${API_PREFIX}/drama-intake/synopsis`, {
      method: "PATCH",
      body: JSON.stringify({ externalDramaId, synopsis }),
    }),
  deleteDramaIntake: (id: string) =>
    request(`${API_PREFIX}/drama-intake/${id}`, { method: "DELETE" }),
  activateDramaPackage: (body: {
    externalDramaId: string;
    title: string;
    sourceUrl: string;
    packageObjectKey?: string;
    packageName?: string;
    asrRuleSetId?: string;
    expectedEpisodeCount?: number;
  }) =>
    request<{
      ok: boolean;
      taskId: string;
      dramaId?: string;
      sourceUrl: string;
      packageName?: string;
      intake?: Record<string, unknown>;
      intakeFound: boolean;
    }>(`${API_PREFIX}/drama-intake/activate-package`, {
      method: "POST",
      body: JSON.stringify(body),
    }),
  deleteTask: (id: string) =>
    request<{ ok: boolean; deletedIds: string[] }>(`${API_PREFIX}/tasks/${id}`, { method: "DELETE" }),
  listAsrResults: (params?: {
    dramaId?: string;
    episodeId?: string;
    deviceId?: string;
    taskKind?: string;
    limit?: number;
    offset?: number;
  }) =>
    request<{ results: Record<string, unknown>[]; total: number; limit: number; offset: number }>(
      `${API_PREFIX}/asr-results${pageQuery(params)}`,
    ),
  getAsrResult: (id: string) =>
    request<{ asrResult: Record<string, unknown> }>(`${API_PREFIX}/asr-results/${id}`),
  getAgentRelease: () =>
    request<{ manifest: Record<string, unknown> }>(`${API_PREFIX}/agent-releases`),
  publishAgentRelease: (body: {
    version: string;
    downloadUrl: string;
    sha256: string;
    mandatory?: boolean;
    releaseNotes?: string;
  }) =>
    request<{ ok: boolean; manifest: Record<string, unknown> }>(`${API_PREFIX}/agent-releases`, {
      method: "PUT",
      body: JSON.stringify(body),
    }),
  uploadAgentRelease: async (input: {
    version: string;
    releaseNotes?: string;
    mandatory?: boolean;
    file: File;
    incrementalFile?: File;
  }) => {
    const form = new FormData();
    form.append("version", input.version);
    if (input.releaseNotes) form.append("releaseNotes", input.releaseNotes);
    form.append("mandatory", input.mandatory ? "true" : "false");
    form.append("file", input.file);
    if (input.incrementalFile) form.append("incrementalFile", input.incrementalFile);
    const headers: Record<string, string> = {};
    const token = getAccessToken();
    if (token) headers.Authorization = `Bearer ${token}`;
    const res = await fetch(`${API_PREFIX}/agent-releases/upload`, {
      method: "POST",
      headers,
      body: form,
    });
    if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
    return res.json() as Promise<{ ok: boolean; manifest: Record<string, unknown> }>;
  },
  listStickerTemplates: () =>
    request<{
      version: string;
      description?: string;
      categories?: Array<{ id: string; name: string; tags?: string[] }>;
      templates: Array<{
        id: string;
        name: string;
        type: string;
        file: string;
        categories?: string[];
        tags?: string[];
        defaultPosition?: string;
        defaultScale?: number;
        durationSec?: number;
        loop?: boolean;
        textPlaceholder?: string | null;
        license?: string;
        licenseScope?: string;
      }>;
    }>(`${API_PREFIX}/stickers/templates`),
  listFonts: () =>
    request<{
      version: string;
      whitelist: Array<{
        value: string;
        label: string;
        source: string;
        license?: string;
        licenseScope?: string;
        fileUrl?: string;
      }>;
      systemFallbacks: Array<{ value: string; label: string }>;
    }>(`${API_PREFIX}/fonts`),
  createRemixReplica: (
    body:
      | {
          dramaId: string;
          caseVideoUrl: string;
          episodeUrls?: string[];
          fissionEnabled?: boolean;
          fissionOps?: string[];
          fissionCount?: number;
        }
      | {
          title: string;
          externalDramaId: string;
          dramaType: "short" | "paid_short" | "comic" | "paid_comic";
          caseVideoUrl: string;
          episodeUrls?: string[];
          fissionEnabled?: boolean;
          fissionOps?: string[];
          fissionCount?: number;
        },
  ) =>
    request<{
      jobId: string;
      status: string;
      dramaId?: string;
      intakeId?: string;
      externalDramaId?: string;
      note?: string;
    }>(`${API_PREFIX}/remix/replica`, {
      method: "POST",
      body: JSON.stringify(body),
    }),
  listRemixReplicas: (dramaId?: string) =>
    request<
      Array<{
        jobId: string;
        dramaId: string | null;
        caseVideoUrl: string;
        status: string;
        outputUrl?: string;
        createdAt: string;
        updatedAt: string;
      }>
    >(dramaId ? `${API_PREFIX}/remix/replica/drama/${encodeURIComponent(dramaId)}` : `${API_PREFIX}/remix/replica`),
  getRemixReplica: (id: string) =>
    request<{
      jobId: string;
      dramaId: string | null;
      caseVideoUrl: string;
      episodeUrls: string[];
      status: string;
      outputUrl?: string;
      timeline?: Record<string, unknown>;
      errorMessage?: string;
      createdAt: string;
      updatedAt: string;
    }>(`${API_PREFIX}/remix/replica/${encodeURIComponent(id)}`),
};
