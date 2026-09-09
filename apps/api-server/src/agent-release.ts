import type { AgentUpdateInfo } from "@clip/sdk";
import { isAgentVersionNewer } from "@clip/sdk";
import type { UpdateManifestRow } from "./mysql/config-repository.js";

export const AGENT_RELEASE_ZIP_NAME = "clip-agent-win-x64.zip";

export function agentReleaseObjectKey(version: string): string {
  return `releases/agent/${version}/${AGENT_RELEASE_ZIP_NAME}`;
}

export function resolveAgentReleaseDownloadUrl(apiBase: string, objectKey: string): string {
  const base = apiBase.replace(/\/$/, "");
  return `${base}/oss/${objectKey.split("/").map(encodeURIComponent).join("/")}`;
}

export function resolveAgentUpdate(input: {
  manifest: UpdateManifestRow;
  deviceVersion: string;
  apiPublicBase: string;
  ossExists: (objectKey: string) => boolean;
}): { updateAvailable: boolean; agentUpdate: AgentUpdateInfo } {
  const { manifest, deviceVersion, apiPublicBase, ossExists } = input;
  const unavailable: AgentUpdateInfo = {
    available: false,
    releaseNotes: manifest.releaseNotes,
  };

  if (!isAgentVersionNewer(manifest.version, deviceVersion)) {
    return { updateAvailable: false, agentUpdate: unavailable };
  }

  const objectKey = agentReleaseObjectKey(manifest.version);
  if (!ossExists(objectKey)) {
    return { updateAvailable: false, agentUpdate: unavailable };
  }

  const agentUpdate: AgentUpdateInfo = {
    available: true,
    version: manifest.version,
    downloadUrl: resolveAgentReleaseDownloadUrl(apiPublicBase, objectKey),
    sha256: manifest.sha256,
    mandatory: manifest.mandatory,
    releaseNotes: manifest.releaseNotes,
  };

  // 如果有增量包，校验存在性后下发
  if (manifest.incrementalUrl && manifest.incrementalSha256) {
    const incObjectKey = agentReleaseObjectKey(manifest.version).replace(".zip", "-incremental.zip");
    if (ossExists(incObjectKey)) {
      agentUpdate.incrementalUrl = manifest.incrementalUrl;
      agentUpdate.incrementalSha256 = manifest.incrementalSha256;
    }
  }

  return { updateAvailable: true, agentUpdate };
}
