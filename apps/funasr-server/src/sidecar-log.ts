/** ModelScope / tqdm / jieba write progress to stderr — not application errors. */

function stripAnsi(text: string): string {
  return text.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "").replace(/\x1b\].*?\x07/g, "");
}

export function isFatalSidecarErrorLine(line: string): boolean {
  const text = stripAnsi(line).trim();
  if (!text) return false;
  if (/ffmpeg is not installed/i.test(text)) return false;
  return (
    /ModuleNotFoundError:\s*No module named ['"]funasr['"]/i.test(text) ||
    /ImportError:\s*cannot import name ['"]AutoModel['"] from ['"]funasr['"]/i.test(text) ||
    /RuntimeError:\s*funasr\s*未安装/i.test(text) ||
    /RuntimeError:\s*funasr 版本/i.test(text) ||
    /funasr\s+未安装[。.，]?\s*请运行/i.test(text) ||
    /funasr 版本 .* 不完整/i.test(text) ||
    /pip install -r.*requirements-funasr/i.test(text)
  );
}

export function findFatalSidecarErrorInChunk(raw: string): string | null {
  for (const line of raw.split(/\r?\n/)) {
    if (!isFatalSidecarErrorLine(line)) continue;
    return "FunASR Python 环境未安装。请重新运行drama-clip安装程序，或重启程序以触发自动配置。";
  }
  return null;
}

export function isBenignSidecarLine(line: string): boolean {
  const text = stripAnsi(line).trim();
  if (!text) return true;
  if (isFatalSidecarErrorLine(text)) return false;
  return (
    /Downloading|Processing \d|%\||it\/s|modelscope|model ready|listening on http/i.test(text) ||
    /^(DEBUG|INFO|WARNING):/i.test(text) ||
    /rtf_avg|Finish downloading|Building prefix|Dumping model|Loading model cost|Prefix dict/i.test(text) ||
    /"GET |"POST |trust_remote_code|\{'load_data'/.test(text) ||
    /funasr version:|modelscope_hub\.download|loading models from/i.test(text) ||
    /^0%\|/.test(text)
  );
}

export function logSidecarOutput(prefix: string, stream: "stdout" | "stderr", raw: string): void {
  for (const line of raw.split(/\r?\n/)) {
    const text = stripAnsi(line).trim();
    if (!text) continue;
    const msg = `${prefix} ${text}`;
    if (stream === "stdout" || isBenignSidecarLine(text)) {
      console.log(msg);
    } else {
      console.error(msg);
    }
  }
}
