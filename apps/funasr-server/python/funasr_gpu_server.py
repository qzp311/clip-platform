#!/usr/bin/env python3
"""
FunASR Sidecar — GPU/CPU auto
协议: GET /health  POST /v1/transcribe

依赖: pip install -r requirements-funasr.txt
模型: 由 --models-dir 指定，或通过 ModelScope 自动下载到该目录
"""
from __future__ import annotations

import argparse
import importlib.metadata
import importlib.util
import json
import os
import sys
import traceback
import wave
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from urllib.parse import urlparse

MODEL = None
MODELS_DIR = ""
DEVICE = "cuda:0"


def _check_funasr_version() -> tuple[str, bool]:
    """检查已安装的 funasr 包版本及 AutoModel 是否可导入，返回 (诊断信息, 是否可用)。"""
    spec = importlib.util.find_spec("funasr")
    if spec is None or spec.origin is None:
        return (
            "funasr 包未安装。请运行: pip install -r apps/funasr-server/python/requirements-funasr.txt",
            False,
        )

    version = "unknown"
    try:
        version = importlib.metadata.version("funasr")
    except Exception:
        pass

    # AutoModel 在 funasr>=1.0 才稳定暴露
    try:
        from funasr import AutoModel  # noqa: F401
    except ImportError as exc:
        return (
            f"funasr 版本 {version} 不完整，无法导入 AutoModel（{exc}）。"
            f"请重新安装: pip install -r apps/funasr-server/python/requirements-funasr.txt"
        ), False

    return f"funasr version={version}", True


def _sanitize_path_for_sentencepiece() -> None:
    """去掉 PATH 中的 torch/nvidia，避免 sentencepiece.pyd 加载到错误 DLL 而 ACCESS_VIOLATION。"""
    bad_needles = (
        "\\torch\\",
        "\\nvidia\\",
        "site-packages\\torch",
        "site-packages\\nvidia",
        "/torch/",
        "/nvidia/",
    )
    cleaned: list[str] = []
    for part in os.environ.get("PATH", "").split(os.pathsep):
        if not part:
            continue
        low = part.lower().replace("/", "\\")
        if any(n in low for n in bad_needles):
            continue
        cleaned.append(part)

    py_dir = Path(sys.executable).resolve().parent
    venv_root = py_dir.parent
    site = venv_root / "Lib" / "site-packages"
    sp_dir = site / "sentencepiece"
    # engines\python（embed）+ 热修旁路 CRT
    engines_python = venv_root.parent.parent / "python"
    crt_dir = venv_root.parent / "runtime" / "crt"
    win = Path(os.environ.get("SystemRoot") or r"C:\Windows")
    system32 = win / "System32"

    head = [str(system32), str(py_dir)]
    for d in (engines_python, crt_dir, sp_dir):
        if d.is_dir():
            head.append(str(d))

    os.environ["PATH"] = os.pathsep.join(head + cleaned)

    _sp_handles: list[Any] = []
    if hasattr(os, "add_dll_directory"):
        for d in head:
            try:
                _sp_handles.append(os.add_dll_directory(d))
            except OSError:
                pass
    sys._clip_sp_dll_handles = _sp_handles  # type: ignore[attr-defined]


def _add_torch_dll_dirs() -> None:
    """sentencepiece 加载完成后再把 torch/nvidia DLL 目录加回来；必须保持 add_dll_directory 句柄存活。"""
    py_dir = Path(sys.executable).resolve().parent
    site = py_dir.parent / "Lib" / "site-packages"
    candidates: list[Path] = [site / "torch" / "lib", site / "nvidia"]
    nvidia = site / "nvidia"
    if nvidia.is_dir():
        for child in nvidia.iterdir():
            for sub in ("bin", "lib", Path("lib") / "x64"):
                candidates.append(child / sub)

    path_parts = os.environ.get("PATH", "").split(os.pathsep)
    # 保存句柄，防止被 Python 垃圾回收后 DLL 搜索目录被移除
    _dll_handles: list[Any] = getattr(sys, "_clip_torch_dll_handles", [])
    for c in candidates:
        if not c.is_dir():
            continue
        s = str(c)
        if s not in path_parts:
            path_parts.insert(0, s)
        if hasattr(os, "add_dll_directory"):
            try:
                h = os.add_dll_directory(s)
                _dll_handles.append(h)
            except OSError:
                pass
    os.environ["PATH"] = os.pathsep.join(path_parts)
    sys._clip_torch_dll_handles = _dll_handles  # type: ignore[attr-defined]


def load_model(models_dir: str, device: str) -> Any:
    global MODEL, MODELS_DIR, DEVICE
    MODELS_DIR = models_dir
    DEVICE = device

    # 1) 先干净加载 sentencepiece（不可先污染 PATH/先 import torch）
    print("[funasr-gpu] step=prepare_dll_path", flush=True)
    _sanitize_path_for_sentencepiece()
    print("[funasr-gpu] step=import_sentencepiece", flush=True)
    import sentencepiece  # noqa: F401
    print(f"[funasr-gpu] sentencepiece OK from {getattr(sentencepiece, '__file__', '?')}", flush=True)

    # 2) 再 import funasr（import_submodules 会复用已加载的 sentencepiece）
    print("[funasr-gpu] step=import_funasr", flush=True)
    funasr_info, funasr_ok = _check_funasr_version()
    print(f"[funasr-gpu] {funasr_info}", flush=True)
    if not funasr_ok:
        raise RuntimeError(funasr_info)

    from funasr import AutoModel

    # 3) 最后 import torch，并补回 CUDA DLL 搜索路径
    print(f"[funasr-gpu] step=import_torch device={device}", flush=True)
    _add_torch_dll_dirs()
    try:
        import torch
        print(
            f"[funasr-gpu] torch={getattr(torch, '__version__', '?')} "
            f"cuda={getattr(torch.version, 'cuda', None)} "
            f"cuda_available={torch.cuda.is_available()}",
            flush=True,
        )
    except Exception as exc:
        print(f"[funasr-gpu] import torch failed: {exc}", flush=True)
        raise

    os.environ.setdefault("MODELSCOPE_CACHE", models_dir)
    print(
        f"[funasr-gpu] step=AutoModel hub=ms models_dir={models_dir} "
        f"(首次会从 modelscope.cn 下载约 1GB)",
        flush=True,
    )
    MODEL = AutoModel(
        model="paraformer-zh",
        model_revision="v2.0.4",
        vad_model="fsmn-vad",
        vad_model_revision="v2.0.4",
        punc_model="ct-punc",
        punc_model_revision="v2.0.4",
        device=device,
        disable_update=True,
        hub="ms",
    )
    print("[funasr-gpu] model ready", flush=True)
    return MODEL


def write_crash_log(models_dir: str, text: str) -> None:
    try:
        path = Path(models_dir) / "funasr-gpu-crash.log"
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text, encoding="utf-8")
        print(f"[funasr-gpu] crash log written: {path}", flush=True)
    except Exception as exc:
        print(f"[funasr-gpu] write crash log failed: {exc}", flush=True)


def wav_duration_ms(path: str) -> int:
    with wave.open(path, "rb") as wf:
        frames = wf.getnframes()
        rate = wf.getframerate()
        return int(frames * 1000 / rate) if rate else 0


def transcribe(audio_path: str, options: dict[str, Any]) -> dict[str, Any]:
    if MODEL is None:
        raise RuntimeError("model not loaded")

    max_seg_ms = int(options.get("maxSingleSegmentMs", 60000))
    batch_size_sec = int(options.get("batchSizeSec", 300))
    hotwords = options.get("hotwords") or []

    hotword_str = ""
    if hotwords:
        hotword_str = " ".join(
            f"{item.get('text', '')} {int(item.get('weight', 10))}"
            for item in hotwords
            if item.get("text")
        )

    kwargs: dict[str, Any] = {
        "input": audio_path,
        "batch_size_s": batch_size_sec,
        "sentence_timestamp": True,
    }
    if hotword_str:
        kwargs["hotword"] = hotword_str

    result = MODEL.generate(**kwargs)
    duration_ms = wav_duration_ms(audio_path)
    raw_segments: list[dict[str, Any]] = []

    if not result:
        return {"rawSegments": [], "durationMs": duration_ms}

    item = result[0] if isinstance(result, list) else result
    text = item.get("text", "") if isinstance(item, dict) else str(item)

    if isinstance(item, dict) and item.get("sentence_info"):
        sentences = item["sentence_info"]
        for idx, sent in enumerate(sentences, start=1):
            start_ms = int(sent.get("start", 0))
            end_ms = int(sent.get("end", start_ms + 1000))
            seg_text = str(sent.get("text", "")).strip()
            is_last = idx == len(sentences)
            # 保留 FunASR 原始时间轴，不因 maxSingleSegmentMs 截断末段（含无语音片尾）
            if not is_last and end_ms - start_ms > max_seg_ms:
                end_ms = start_ms + max_seg_ms
            if not seg_text and not is_last:
                continue
            raw_segments.append({
                "id": f"r{idx:03d}",
                "startMs": start_ms,
                "endMs": end_ms,
                "text": seg_text,
                "confidence": float(sent.get("confidence", 0.9)),
            })
    elif text.strip():
        raw_segments.append({
            "id": "r001",
            "startMs": 0,
            "endMs": duration_ms,
            "text": text.strip(),
            "confidence": 0.9,
        })

    # 末段对齐 wav 全长（台词结束后可能仍有静音，但无法覆盖无音轨片尾；由 Agent ffprobe 视频补齐）
    if raw_segments and duration_ms > raw_segments[-1]["endMs"]:
        raw_segments[-1]["endMs"] = duration_ms

    return {"rawSegments": raw_segments, "durationMs": duration_ms}


class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt: str, *args: Any) -> None:
        print(f"[funasr-gpu] {self.address_string()} - {fmt % args}", flush=True)

    def _json(self, code: int, payload: dict[str, Any]) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self) -> None:
        if urlparse(self.path).path == "/health":
            self._json(200, {
                "ok": True,
                "backend": "funasr-gpu",
                "device": DEVICE,
                "modelsDir": MODELS_DIR,
            })
            return
        self._json(404, {"error": "not found"})

    def do_POST(self) -> None:
        if urlparse(self.path).path != "/v1/transcribe":
            self._json(404, {"error": "not found"})
            return
        length = int(self.headers.get("Content-Length", 0))
        raw = self.rfile.read(length).decode("utf-8") if length else "{}"
        try:
            body = json.loads(raw)
            audio_path = body.get("audioPath")
            if not audio_path:
                self._json(400, {"error": "audioPath required"})
                return
            if not os.path.isfile(audio_path):
                self._json(400, {"error": f"audio not found: {audio_path}"})
                return
            result = transcribe(audio_path, body.get("options") or {})
            self._json(200, result)
        except Exception as exc:
            self._json(500, {"error": str(exc)})


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=17860)
    parser.add_argument("--device", default="cuda:0")
    parser.add_argument("--models-dir", default=os.environ.get("CLIP_FUNASR_MODELS_DIR", "models"))
    args = parser.parse_args()

    models_dir = str(Path(args.models_dir).resolve())
    Path(models_dir).mkdir(parents=True, exist_ok=True)
    print(
        f"[funasr-gpu] starting host={args.host} port={args.port} "
        f"device={args.device} models={models_dir} python={sys.executable}",
        flush=True,
    )

    try:
        load_model(models_dir, args.device)
    except Exception as exc:
        import traceback
        tb = traceback.format_exc()
        msg = f"[funasr-gpu] load_model failed: {exc}\n{tb}"
        print(msg, flush=True)
        write_crash_log(models_dir, msg)
        # CUDA 崩了再试 CPU（识别仍可用）
        if str(args.device).startswith("cuda"):
            print("[funasr-gpu] retry load_model on cpu…", flush=True)
            try:
                load_model(models_dir, "cpu")
            except Exception as exc2:
                tb2 = traceback.format_exc()
                msg2 = f"[funasr-gpu] cpu load_model failed: {exc2}\n{tb2}"
                print(msg2, flush=True)
                write_crash_log(models_dir, msg + "\n" + msg2)
                sys.exit(1)
        else:
            sys.exit(1)

    server = ThreadingHTTPServer((args.host, args.port), Handler)
    print(f"funasr-gpu listening on http://{args.host}:{args.port}", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        import traceback
        print(f"[funasr-gpu] fatal: {exc}", flush=True)
        traceback.print_exc()
        sys.exit(1)
