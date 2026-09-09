from __future__ import annotations

import csv
import functools
import hashlib
import json
import os
import re
import subprocess
import tempfile
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Callable, Sequence

import shutil
import numpy as np


LogCallback = Callable[[str], None]
ProgressCallback = Callable[[float], None]


@dataclass
class VideoInfo:
    path: str
    duration: float
    width: int
    height: int
    fps: float


@dataclass
class Segment:
    reference_start: float
    reference_end: float
    source_index: int | None
    source_start: float | None
    source_end: float | None
    speed: float | None
    confidence: float
    status: str

    @property
    def duration(self) -> float:
        return self.reference_end - self.reference_start


@dataclass
class AnalysisResult:
    reference: VideoInfo
    sources: list[VideoInfo]
    segments: list[Segment]
    sample_fps: float
    matched_seconds: float
    unmatched_seconds: float
    # 多案例时保存全部参考视频（兼容旧数据：无该字段时等价于单条 reference）
    references: list[VideoInfo] | None = None


def _ffmpeg() -> str:
    p = os.environ.get("CLIP_FFMPEG_PATH") or shutil.which("ffmpeg")
    if not p:
        raise RuntimeError("ffmpeg not found: set CLIP_FFMPEG or ensure ffmpeg is on PATH")
    return p


@functools.lru_cache(maxsize=1)
def _nvenc_available() -> bool:
    try:
        proc = subprocess.run(
            [_ffmpeg(), "-hide_banner", "-encoders"],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            encoding="utf-8",
            errors="replace",
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        )
        return "h264_nvenc" in proc.stdout
    except Exception:
        return False


def _source_fingerprint(path: str | Path) -> str:
    """为原片生成稳定标识：文件名 + 文件大小；不存在则回退 URL 哈希。

    不使用 mtime，保证同一剧目的分集在不同 Agent/不同时间下载后指纹一致，
    从而复用 clip_drama 表中登记的复刻特征缓存。
    """
    file_path = Path(path)
    if file_path.exists():
        stat = file_path.stat()
        return f"{file_path.name}:{stat.st_size}"
    # 网络 URL 回退：取 URL 字符串 sha256 前 16 位
    return hashlib.sha256(str(path).encode("utf-8")).hexdigest()[:16]


def _source_cache_dir(cache_dir: Path, source_paths: Sequence[str | Path]) -> Path:
    """按原片集合生成子目录，避免不同剧集/不同版本冲突。"""
    fingerprints = sorted(_source_fingerprint(p) for p in source_paths)
    digest = hashlib.sha256("|".join(fingerprints).encode("utf-8")).hexdigest()[:12]
    return cache_dir / digest


def _load_source_features(
    cache_path: Path,
    source_paths: Sequence[str | Path],
    log: LogCallback = print,
) -> tuple[np.ndarray, np.ndarray, np.ndarray] | None:
    """从 npz 文件加载原片特征。返回 (features, source_ids, source_local)；缓存无效时返回 None。

    兼容旧缓存：source_paths 顺序可能和保存时不一致，按 fingerprint 重新映射 source_ids。
    """
    try:
        if not cache_path.exists():
            return None
        # 历史缓存使用 object 数组保存字符串，必须 allow_pickle=True 才能读取
        data = np.load(cache_path, allow_pickle=True)
        cached_fingerprints = data.get("source_fingerprints", np.array([]))
        # 显式转 str，兼容 numpy.str_ / bytes 等多种类型
        cached_fingerprints = [str(item) for item in cached_fingerprints]
        current_fingerprints = [_source_fingerprint(p) for p in source_paths]

        if sorted(cached_fingerprints) != sorted(current_fingerprints):
            log(f"[remix-cache] 缓存原片集合已变更，重新提取: {cache_path}")
            return None

        if cached_fingerprints == current_fingerprints:
            return data["features"], data["source_ids"], data["source_local"]

        # 顺序不一致时，按 fingerprint 重新映射 source_ids
        cached_to_current = {fp: idx for idx, fp in enumerate(current_fingerprints)}
        if not all(fp in cached_to_current for fp in cached_fingerprints):
            log(f"[remix-cache] 缓存原片映射失败，重新提取: {cache_path}")
            return None

        mapping = np.array([cached_to_current[fp] for fp in cached_fingerprints], dtype=np.int16)
        remapped_source_ids = mapping[data["source_ids"]]
        log(f"[remix-cache] 命中缓存并兼容旧顺序映射: {cache_path}")
        return data["features"], remapped_source_ids, data["source_local"]
    except Exception as exc:
        log(f"[remix-cache] 加载缓存失败，重新提取: {exc}")
        return None


def _save_source_features(
    cache_path: Path,
    source_paths: Sequence[str | Path],
    features: np.ndarray,
    source_ids: np.ndarray,
    source_local: np.ndarray,
    log: LogCallback = print,
) -> None:
    """保存原片特征到单个 npz 文件。"""
    try:
        cache_path.parent.mkdir(parents=True, exist_ok=True)
        # 保存排序后的 fingerprint；使用固定长度字节数组，避免 allow_pickle 限制
        sorted_fingerprints = sorted(_source_fingerprint(p) for p in source_paths)
        max_len = max((len(fp) for fp in sorted_fingerprints), default=0)
        if max_len == 0:
            fingerprint_bytes = np.zeros((len(sorted_fingerprints), 0), dtype=np.uint8)
        else:
            # 用 frombuffer 逐行构建，避免 numpy 对 bytes 对象调用 int()
            rows = [np.frombuffer(fp.ljust(max_len).encode("utf-8"), dtype=np.uint8) for fp in sorted_fingerprints]
            fingerprint_bytes = np.stack(rows)
        np.savez(
            cache_path,
            features=features,
            source_ids=source_ids,
            source_local=source_local,
            source_fingerprints=fingerprint_bytes,
            feature_count=int(features.shape[0]),
        )
    except Exception as exc:
        # 缓存失败不阻断主流程
        log(f"[remix-cache] 保存缓存失败: {exc}")


def _run_probe(path: Path) -> str:
    proc = subprocess.run(
        [_ffmpeg(), "-hide_banner", "-i", str(path)],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        encoding="utf-8",
        errors="replace",
        creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
    )
    return proc.stderr


def _has_audio(path: str | Path) -> bool:
    return bool(re.search(r"Stream\s+#\S+:\s*Audio:", _run_probe(Path(path))))


def _atempo_filter(speed: float) -> str:
    """Build an atempo chain whose individual factors stay within 0.5..2.0."""
    remaining = max(float(speed), 1e-6)
    factors: list[float] = []
    while remaining > 2.0 + 1e-9:
        factors.append(2.0)
        remaining /= 2.0
    while remaining < 0.5 - 1e-9:
        factors.append(0.5)
        remaining /= 0.5
    if abs(remaining - 1.0) > 1e-6 or not factors:
        factors.append(remaining)
    return ",".join(f"atempo={factor:.9f}" for factor in factors)


def probe(path: str | Path) -> VideoInfo:
    file_path = Path(path)
    output = _run_probe(file_path)
    duration_match = re.search(r"Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)", output)
    video_match = re.search(
        r"Video:.*?\b(\d{2,5})x(\d{2,5})\b.*?(\d+(?:\.\d+)?)\s*fps", output
    )
    if not duration_match or not video_match:
        raise RuntimeError(f"无法读取视频信息：{file_path}")
    hours, minutes, seconds = duration_match.groups()
    width, height, fps = video_match.groups()
    duration = int(hours) * 3600 + int(minutes) * 60 + float(seconds)
    return VideoInfo(str(file_path), duration, int(width), int(height), float(fps))


def _extract_features(path: Path, fps: float, width: int = 32, height: int = 18) -> np.ndarray:
    # Vertical commentary materials commonly embed the drama frame between a
    # fixed title and footer. The central content band is about 44% of the frame
    # height; after normalizing it to 16:9 it can be compared with the original
    # landscape source despite the commentary template's reframing.
    video_filter = (
        f"fps={fps},"
        "crop=w='floor(iw/2)*2':"
        "h='if(gt(ih,iw),floor((ih*0.44)/2)*2,floor(ih/2)*2)':"
        "x=0:y='if(gt(ih,iw),floor(ih*0.28),0)',"
        f"scale={width}:{height}:flags=area,format=gray"
    )
    command = [
        _ffmpeg(),
        "-hide_banner",
        "-loglevel",
        "error",
        "-i",
        str(path),
        "-an",
        "-vf",
        video_filter,
        "-f",
        "rawvideo",
        "-pix_fmt",
        "gray",
        "pipe:1",
    ]
    proc = subprocess.run(
        command,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
    )
    if proc.returncode:
        raise RuntimeError(proc.stderr.decode("utf-8", "replace"))
    frame_size = width * height
    usable = len(proc.stdout) // frame_size * frame_size
    if usable == 0:
        raise RuntimeError(f"视频解码失败：{path}")
    frames = np.frombuffer(proc.stdout[:usable], dtype=np.uint8).reshape(-1, frame_size)
    features = frames.astype(np.float32)
    features -= features.mean(axis=1, keepdims=True)
    features /= np.maximum(np.linalg.norm(features, axis=1, keepdims=True), 1e-6)
    return features


def _nearest_matches(
    reference: np.ndarray,
    sources: np.ndarray,
    progress: ProgressCallback,
) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    best_index = np.empty(len(reference), dtype=np.int32)
    best_score = np.empty(len(reference), dtype=np.float32)
    second_score = np.empty(len(reference), dtype=np.float32)
    chunk = 96
    for start in range(0, len(reference), chunk):
        end = min(start + chunk, len(reference))
        scores = reference[start:end] @ sources.T
        top2 = np.argpartition(scores, -2, axis=1)[:, -2:]
        top2_scores = np.take_along_axis(scores, top2, axis=1)
        order = np.argsort(top2_scores, axis=1)
        row = np.arange(end - start)
        best_index[start:end] = top2[row, order[:, 1]]
        best_score[start:end] = top2_scores[row, order[:, 1]]
        second_score[start:end] = top2_scores[row, order[:, 0]]
        progress(0.55 + 0.25 * end / len(reference))
    return best_index, best_score, second_score


def _fill_short_gaps(labels: np.ndarray, max_gap: int) -> np.ndarray:
    result = labels.copy()
    index = 0
    while index < len(result):
        if result[index] != -1:
            index += 1
            continue
        end = index
        while end < len(result) and result[end] == -1:
            end += 1
        left = result[index - 1] if index else -1
        right = result[end] if end < len(result) else -1
        if end - index <= max_gap and left == right and left != -1:
            result[index:end] = left
        index = end
    return result


def _smooth_labels(raw_labels: np.ndarray, radius: int = 3) -> np.ndarray:
    labels = np.full(len(raw_labels), -1, dtype=np.int16)
    for index in range(len(raw_labels)):
        window = raw_labels[max(0, index - radius) : min(len(raw_labels), index + radius + 1)]
        valid = window[window >= 0]
        if len(valid) < 2:
            continue
        counts = np.bincount(valid)
        winner = int(np.argmax(counts))
        if counts[winner] >= max(2, int(np.ceil(len(window) * 0.4))):
            labels[index] = winner
    return _fill_short_gaps(labels, max_gap=4)


def _robust_line(x: np.ndarray, y: np.ndarray) -> tuple[float, float, np.ndarray]:
    keep = np.ones(len(x), dtype=bool)
    speed, offset = 1.0, float(y[0] - x[0])
    for _ in range(4):
        if keep.sum() < 2:
            break
        speed, offset = np.polyfit(x[keep], y[keep], 1)
        residual = np.abs(y - (speed * x + offset))
        median = float(np.median(residual[keep]))
        new_keep = residual <= max(0.8, median * 3 + 0.25)
        if np.array_equal(new_keep, keep):
            break
        keep = new_keep
    return float(speed), float(offset), keep


def _segments_from_matches(
    reference: VideoInfo,
    sources: Sequence[VideoInfo],
    source_ids: np.ndarray,
    source_local: np.ndarray,
    best_index: np.ndarray,
    scores: np.ndarray,
    fps: float,
    threshold: float,
) -> list[Segment]:
    raw_labels = np.where(scores >= threshold, source_ids[best_index], -1).astype(np.int16)
    labels = _smooth_labels(raw_labels)
    raw_source_times = source_local[best_index] / fps

    runs: list[tuple[int, int, int]] = []
    start = 0
    for index in range(1, len(labels) + 1):
        if index == len(labels) or labels[index] != labels[start]:
            runs.append((start, index, int(labels[start])))
            start = index

    segments: list[Segment] = []
    for start_index, end_index, label in runs:
        reference_start = start_index / fps
        reference_end = min(reference.duration, end_index / fps)
        if reference_end <= reference_start:
            continue
        anchor_indices = np.arange(start_index, end_index)
        if label >= 0:
            anchor_indices = anchor_indices[
                (raw_labels[anchor_indices] == label) & (scores[anchor_indices] >= threshold)
            ]
        if label < 0 or len(anchor_indices) < 3:
            segments.append(
                Segment(reference_start, reference_end, None, None, None, None, 0.0, "缺少原片")
            )
            continue

        x = anchor_indices / fps
        y = raw_source_times[anchor_indices]
        speed, offset, keep = _robust_line(x, y)
        if not (0.25 <= speed <= 4.0) or keep.sum() < 3:
            segments.append(
                Segment(reference_start, reference_end, None, None, None, None, 0.0, "匹配不稳定")
            )
            continue
        source_start = max(0.0, speed * reference_start + offset)
        source_end = min(sources[label].duration, speed * reference_end + offset)
        actual_reference_end = min(reference_end, reference_start + (source_end - source_start) / speed)
        confidence = float(np.median(scores[anchor_indices[keep]]))
        segments.append(
            Segment(
                reference_start,
                actual_reference_end,
                label,
                source_start,
                source_end,
                speed,
                confidence,
                "已匹配",
            )
        )
        if actual_reference_end + 1e-3 < reference_end:
            segments.append(
                Segment(actual_reference_end, reference_end, None, None, None, None, 0.0, "缺少原片")
            )

    # Ensure that rounding never leaves holes in the reference timeline.
    normalized: list[Segment] = []
    cursor = 0.0
    for segment in segments:
        if segment.reference_start > cursor + 1e-3:
            normalized.append(Segment(cursor, segment.reference_start, None, None, None, None, 0.0, "缺少原片"))
        segment.reference_start = max(cursor, segment.reference_start)
        if segment.reference_end > segment.reference_start + 1e-3:
            normalized.append(segment)
            cursor = segment.reference_end
    if cursor < reference.duration - 1e-3:
        normalized.append(Segment(cursor, reference.duration, None, None, None, None, 0.0, "缺少原片"))
    return normalized


def _add_source_fallbacks(
    segments: list[Segment],
    sources: Sequence[VideoInfo],
    source_ids: np.ndarray,
    source_local: np.ndarray,
    best_index: np.ndarray,
    scores: np.ndarray,
    fps: float,
    chunk_seconds: float = 1.5,
) -> list[Segment]:
    """Attach source-only candidates to every unmatched reference interval.

    Commentary edits often contain large captions, stickers or reframing that can
    push an otherwise useful visual match below the safe threshold.  These
    candidates are deliberately marked low-confidence and are only used when the
    renderer is placed in source-only mode.
    """
    result: list[Segment] = []
    for segment in segments:
        if segment.source_index is not None:
            result.append(segment)
            continue
        cursor = segment.reference_start
        while cursor < segment.reference_end - 1e-3:
            end = min(segment.reference_end, cursor + chunk_seconds)
            first = max(0, int(np.floor(cursor * fps)))
            last = min(len(best_index), max(first + 1, int(np.ceil(end * fps))))
            sample_indices = np.arange(first, last)
            if len(sample_indices) == 0:
                result.append(Segment(cursor, end, None, None, None, None, 0.0, "缺少原片"))
                cursor = end
                continue
            candidates = best_index[sample_indices]
            candidate_files = source_ids[candidates]
            # Sum positive similarity by source file. This is more stable than a
            # raw vote when one strong matching frame is surrounded by overlays.
            weights = np.maximum(scores[sample_indices], 0.0)
            totals = np.bincount(candidate_files, weights=weights, minlength=len(sources))
            file_id = int(np.argmax(totals))
            belonging = sample_indices[candidate_files == file_id]
            if len(belonging) == 0:
                belonging = sample_indices
            belonging_candidates = best_index[belonging]
            best_sample = int(belonging[np.argmax(scores[belonging])])
            anchor_candidate = int(best_index[best_sample])
            anchor_reference = best_sample / fps
            anchor_source = float(source_local[anchor_candidate]) / fps

            speed = 1.0
            if len(belonging) >= 3:
                x = belonging / fps
                y = source_local[belonging_candidates] / fps
                fitted_speed, _, keep = _robust_line(x, y)
                if keep.sum() >= 3 and 0.5 <= fitted_speed <= 3.0:
                    speed = fitted_speed
            source_start = anchor_source - (anchor_reference - cursor) * speed
            source_start = max(0.0, min(source_start, max(0.0, sources[file_id].duration - (end - cursor) * speed)))
            source_end = min(sources[file_id].duration, source_start + (end - cursor) * speed)
            actual_end = min(end, cursor + (source_end - source_start) / max(speed, 1e-6))
            confidence = float(np.median(scores[belonging]))
            result.append(
                Segment(
                    cursor,
                    actual_end,
                    file_id,
                    source_start,
                    source_end,
                    speed,
                    confidence,
                    "低置信度原片候选",
                )
            )
            if actual_end < end - 1e-3:
                result.append(Segment(actual_end, end, None, None, None, None, 0.0, "缺少原片"))
            cursor = end
    return result


def analyze(
    reference_paths: Sequence[str | Path],
    source_paths: Sequence[str | Path],
    output_dir: str | Path,
    log: LogCallback = print,
    progress: ProgressCallback = lambda value: None,
    sample_fps: float = 4.0,
    threshold: float = 0.86,
    cache_dir: str | Path | None = None,
    feature_cache_path: str | Path | None = None,
) -> AnalysisResult:
    if not source_paths:
        raise ValueError("请至少添加一个原片")
    if not reference_paths:
        raise ValueError("请至少添加一条案例视频")
    output = Path(output_dir)
    output.mkdir(parents=True, exist_ok=True)
    log("读取视频信息……")
    references = [probe(path) for path in reference_paths]
    sources = [probe(path) for path in source_paths]
    progress(0.05)

    log(f"提取 {len(references)} 条案例参考片视觉指纹……")
    all_reference_features: list[np.ndarray] = []
    for index, ref in enumerate(references):
        log(f"提取参考片 {index + 1}/{len(references)}：{Path(ref.path).name}")
        all_reference_features.append(_extract_features(Path(ref.path), sample_fps))
        progress(0.05 + 0.13 * (index + 1) / len(references))
    # 多条案例按顺序拼接为一条复合参考时间线
    reference_features = np.concatenate(all_reference_features)
    total_duration = sum(ref.duration for ref in references)
    reference = VideoInfo(
        references[0].path,
        total_duration,
        references[0].width,
        references[0].height,
        references[0].fps,
    )
    progress(0.18)

    cache_root = Path(cache_dir) if cache_dir else None
    explicit_cache = Path(feature_cache_path) if feature_cache_path else None
    # 优先使用显式指定的 npz 缓存文件；其次使用 cache_dir 下的按指纹子目录
    if explicit_cache is not None:
        feature_cache = explicit_cache
    elif cache_root is not None:
        feature_cache = cache_root / _source_cache_dir(cache_root, source_paths) / "features.npz"
    else:
        feature_cache = None

    cached = feature_cache and _load_source_features(feature_cache, source_paths, log)

    if cached is not None:
        source_features, source_ids_array, source_local_array = cached
        log(f"命中原片特征缓存：{feature_cache}")
        progress(0.53)
    else:
        all_features: list[np.ndarray] = [np.empty((0, 0), dtype=np.float32)] * len(sources)

        # 原片特征提取以 I/O 为主（ffmpeg 解码），用线程池并行加速
        max_workers = min(len(sources), max(2, os.cpu_count() or 4))
        log(f"并行提取 {len(sources)} 个原片特征（workers={max_workers}）……")
        with ThreadPoolExecutor(max_workers=max_workers) as executor:
            future_to_index = {
                executor.submit(_extract_features, Path(source.path), sample_fps): index
                for index, source in enumerate(sources)
            }
            completed = 0
            for future in as_completed(future_to_index):
                index = future_to_index[future]
                features = future.result()
                all_features[index] = features
                completed += 1
                log(f"检索原片 {completed}/{len(sources)}：{Path(sources[index].path).name}")
                progress(0.18 + 0.35 * completed / len(sources))

        source_features = np.concatenate(all_features)
        # 按 source 顺序重建 frame 到 source 的映射
        source_ids: list[int] = []
        source_local: list[int] = []
        for index, features in enumerate(all_features):
            source_ids.extend([index] * len(features))
            source_local.extend(range(len(features)))
        source_ids_array = np.asarray(source_ids, dtype=np.int16)
        source_local_array = np.asarray(source_local, dtype=np.int32)

        if feature_cache is not None:
            _save_source_features(feature_cache, source_paths, source_features, source_ids_array, source_local_array, log)
            log(f"原片特征已缓存：{feature_cache}")

    log("全库画面比对……")
    best_index, scores, second_scores = _nearest_matches(
        reference_features, source_features, progress
    )
    effective_threshold = threshold
    if reference.height > reference.width and any(
        source.width > source.height for source in sources
    ):
        # Portrait commentary templates reframe and recompress the embedded
        # landscape footage, lowering raw pixel correlation even for correct
        # matches. A calibrated lower threshold still relies on temporal line
        # fitting before a segment is accepted.
        effective_threshold = min(threshold, 0.68)
        log(f"检测到竖屏参考/横屏原片，启用重构素材匹配阈值：{effective_threshold:.2f}")
    segments = _segments_from_matches(
        reference,
        sources,
        source_ids_array,
        source_local_array,
        best_index,
        scores,
        sample_fps,
        effective_threshold,
    )
    segments = _add_source_fallbacks(
        segments,
        sources,
        source_ids_array,
        source_local_array,
        best_index,
        scores,
        sample_fps,
    )
    matched = sum(segment.duration for segment in segments if segment.status == "已匹配")
    unmatched = max(0.0, total_duration - matched)
    result = AnalysisResult(
        reference,
        sources,
        segments,
        sample_fps,
        matched,
        unmatched,
        references=references,
    )
    save_reports(result, output, best_index, scores, second_scores, source_ids_array, source_local_array)
    progress(1.0)
    log(f"分析完成：匹配 {matched:.1f} 秒，缺少原片 {unmatched:.1f} 秒")
    return result


def save_reports(
    result: AnalysisResult,
    output_dir: Path,
    best_index: np.ndarray | None = None,
    scores: np.ndarray | None = None,
    second_scores: np.ndarray | None = None,
    source_ids: np.ndarray | None = None,
    source_local: np.ndarray | None = None,
) -> None:
    payload = {
        "reference": asdict(result.reference),
        "references": [asdict(item) for item in (result.references or [result.reference])],
        "sources": [asdict(item) for item in result.sources],
        "segments": [asdict(item) for item in result.segments],
        "sample_fps": result.sample_fps,
        "matched_seconds": result.matched_seconds,
        "unmatched_seconds": result.unmatched_seconds,
    }
    (output_dir / "匹配时间线.json").write_text(
        json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    with (output_dir / "匹配时间线.csv").open("w", newline="", encoding="utf-8-sig") as handle:
        writer = csv.writer(handle)
        writer.writerow(
            ["状态", "参考入点", "参考出点", "原片", "原片入点", "原片出点", "倍速", "置信度"]
        )
        for segment in result.segments:
            source_name = (
                Path(result.sources[segment.source_index].path).name
                if segment.source_index is not None
                else ""
            )
            writer.writerow(
                [
                    segment.status,
                    f"{segment.reference_start:.3f}",
                    f"{segment.reference_end:.3f}",
                    source_name,
                    "" if segment.source_start is None else f"{segment.source_start:.3f}",
                    "" if segment.source_end is None else f"{segment.source_end:.3f}",
                    "" if segment.speed is None else f"{segment.speed:.4f}",
                    f"{segment.confidence:.4f}",
                ]
            )

    if best_index is not None and scores is not None and source_ids is not None and source_local is not None:
        with (output_dir / "逐点匹配明细.csv").open("w", newline="", encoding="utf-8-sig") as handle:
            writer = csv.writer(handle)
            writer.writerow(["参考时间", "最相似原片", "原片时间", "相似度", "领先第二候选"])
            for index, source_index in enumerate(best_index):
                file_id = int(source_ids[source_index])
                writer.writerow(
                    [
                        f"{index / result.sample_fps:.3f}",
                        Path(result.sources[file_id].path).name,
                        f"{source_local[source_index] / result.sample_fps:.3f}",
                        f"{scores[index]:.6f}",
                        "" if second_scores is None else f"{scores[index] - second_scores[index]:.6f}",
                    ]
                )


def load_analysis(path: str | Path) -> AnalysisResult:
    payload = json.loads(Path(path).read_text(encoding="utf-8"))
    references_raw = payload.get("references")
    references = (
        [VideoInfo(**item) for item in references_raw]
        if isinstance(references_raw, list) and references_raw
        else [VideoInfo(**payload["reference"])]
    )
    return AnalysisResult(
        VideoInfo(**payload["reference"]),
        [VideoInfo(**item) for item in payload["sources"]],
        [Segment(**item) for item in payload["segments"]],
        payload["sample_fps"],
        payload["matched_seconds"],
        payload["unmatched_seconds"],
        references=references,
    )


def _split_segment_across_references(
    references: Sequence[VideoInfo],
    segment: Segment,
) -> list[tuple[int, float, float]]:
    """把复合时间轴上的 segment 拆分到具体参考视频：返回 (reference_index, local_start, local_end)。

    多案例参考按顺序拼接成复合时间线；segment 可能横跨多个参考视频的边界，
    渲染时需要按参考视频拆成多个子段分别 trim。
    """
    offsets: list[float] = []
    acc = 0.0
    for ref in references:
        offsets.append(acc)
        acc += ref.duration
    parts: list[tuple[int, float, float]] = []
    cursor = segment.reference_start
    end = segment.reference_end
    if end <= cursor + 1e-6:
        return parts
    for index in range(len(references)):
        ref_start = offsets[index]
        ref_end = ref_start + references[index].duration
        if cursor >= ref_end - 1e-6:
            continue
        local_start = max(0.0, cursor - ref_start)
        local_end = min(end, ref_end) - ref_start
        if local_end > local_start + 1e-6:
            parts.append((index, local_start, local_end))
        cursor = min(end, ref_end)
        if cursor >= end - 1e-6:
            break
    return parts


def render(
    result: AnalysisResult,
    output_path: str | Path,
    keep_unmatched_reference: bool = True,
    source_only: bool = False,
    source_audio: bool = False,
    log: LogCallback = print,
    progress: ProgressCallback = lambda value: None,
) -> Path:
    output_file = Path(output_path)
    output_file.parent.mkdir(parents=True, exist_ok=True)
    references = list(result.references) if result.references else [result.reference]
    command = [_ffmpeg(), "-y", "-hide_banner", "-loglevel", "error", "-progress", "pipe:1"]
    for ref in references:
        command += ["-i", ref.path]
    for source in result.sources:
        command += ["-i", source.path]

    filters: list[str] = []
    video_labels: list[str] = []
    audio_labels: list[str] = []
    source_audio_available = [_has_audio(source.path) for source in result.sources] if source_audio else []
    reference_audio_available = [_has_audio(ref.path) for ref in references] if source_audio else []
    rendered_duration = 0.0
    for index, segment in enumerate(result.segments):
        video_label = f"v{index}"
        audio_label = f"a{index}"
        use_source = segment.source_index is not None and (
            segment.status == "已匹配" or source_only
        )
        if use_source:
            input_index = segment.source_index + len(references)
            filters.append(
                f"[{input_index}:v]trim=start={segment.source_start:.6f}:end={segment.source_end:.6f},"
                f"setpts=(PTS-STARTPTS)/{segment.speed:.9f},"
        f"scale={result.reference.width}:{result.reference.height}:force_original_aspect_ratio=decrease:flags=bicubic,"
        f"pad={result.reference.width}:{result.reference.height}:(ow-iw)/2:(oh-ih)/2:color=black,"
        f"setsar=1,fps={result.reference.fps:.6f},format=yuv420p[{video_label}]"
            )
        elif keep_unmatched_reference and not source_only:
            parts = _split_segment_across_references(references, segment)
            for part_index, (ref_index, local_start, local_end) in enumerate(parts):
                part_label = f"v{index}p{part_index}"
                filters.append(
                    f"[{ref_index}:v]trim=start={local_start:.6f}:end={local_end:.6f},"
                    f"setpts=PTS-STARTPTS,"
        f"scale={result.reference.width}:{result.reference.height}:force_original_aspect_ratio=decrease:flags=bicubic,"
        f"pad={result.reference.width}:{result.reference.height}:(ow-iw)/2:(oh-ih)/2:color=black,"
        f"setsar=1,format=yuv420p[{part_label}]"
                )
                video_labels.append(f"[{part_label}]")
                rendered_duration += local_end - local_start
                if source_audio:
                    part_audio_label = f"a{index}p{part_index}"
                    if reference_audio_available[ref_index]:
                        filters.append(
                            f"[{ref_index}:a]atrim=start={local_start:.6f}:end={local_end:.6f},"
                            f"asetpts=PTS-STARTPTS,apad,atrim=duration={local_end - local_start:.6f},"
                            f"aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo[{part_audio_label}]"
                        )
                    else:
                        filters.append(
                            f"anullsrc=r=48000:cl=stereo,atrim=duration={local_end - local_start:.6f}[{part_audio_label}]"
                        )
                    audio_labels.append(f"[{part_audio_label}]")
            continue
        else:
            filters.append(
                f"color=c=black:s={result.reference.width}x{result.reference.height}:"
                f"r={result.reference.fps:.6f}:d={segment.duration:.6f},setsar=1[{video_label}]"
            )
        video_labels.append(f"[{video_label}]")

        if source_audio:
            if use_source and source_audio_available[segment.source_index]:
                input_index = segment.source_index + len(references)
                filters.append(
                    f"[{input_index}:a]atrim=start={segment.source_start:.6f}:end={segment.source_end:.6f},"
                    f"asetpts=PTS-STARTPTS,{_atempo_filter(segment.speed)},"
                    f"apad,atrim=duration={segment.duration:.6f},"
                    f"aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo[{audio_label}]"
                )
            elif not source_only and len(reference_audio_available) > 0 and reference_audio_available[0]:
                filters.append(
                    f"[0:a]atrim=start={segment.reference_start:.6f}:end={segment.reference_end:.6f},"
                    f"asetpts=PTS-STARTPTS,apad,atrim=duration={segment.duration:.6f},"
                    f"aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo[{audio_label}]"
                )
            else:
                filters.append(
                    f"anullsrc=r=48000:cl=stereo,atrim=duration={segment.duration:.6f}[{audio_label}]"
                )
            audio_labels.append(f"[{audio_label}]")
        rendered_duration += segment.duration
    if source_audio:
        concat_inputs = "".join(
            video + audio for video, audio in zip(video_labels, audio_labels)
        )
        filters.append(concat_inputs + f"concat=n={len(video_labels)}:v=1:a=1[vout][aout]")
    else:
        filters.append("".join(video_labels) + f"concat=n={len(video_labels)}:v=1:a=0[vout]")
    filter_script = ";".join(filters)
    # Commentary edits can create hundreds of short segments. Passing the full
    # graph via -filter_complex exceeds Windows' command-line limit (WinError
    # 206), so write the graph to a script file and keep argv compact.
    script_handle = tempfile.NamedTemporaryFile(
        mode="w",
        encoding="utf-8",
        newline="\n",
        suffix=".fffilter",
        prefix="drama_replica_",
        dir=output_file.parent,
        delete=False,
    )
    filter_script_path = Path(script_handle.name)
    try:
        script_handle.write(filter_script)
    finally:
        script_handle.close()
    command += [
        "-filter_complex_script",
        str(filter_script_path),
        "-map",
        "[vout]",
    ]
    if source_audio:
        command += ["-map", "[aout]"]
    else:
        command += ["-map", "0:a?"]
    output_options = [
        "-c:a",
        "aac",
        "-b:a",
        "192k",
        "-t",
        f"{rendered_duration:.6f}",
        "-movflags",
        "+faststart",
        str(output_file),
    ]
    log("开始生成复刻视频……")
    _run_render_with_fallback(command, output_options, filter_script_path, rendered_duration, progress, log)
    progress(1.0)
    log(f"视频已生成：{output_file}")
    return output_file


def _run_render_with_fallback(
    base_command: list[str],
    output_options: list[str],
    filter_script_path: Path,
    rendered_duration: float,
    progress: ProgressCallback,
    log: LogCallback,
) -> None:
    """优先尝试 NVENC 硬编，失败自动回退到 libx264 软编；脚本文件在所有尝试结束后清理。"""
    try:
        if _nvenc_available():
            nvenc_command = base_command + [
                "-c:v", "h264_nvenc",
                "-preset", "p4",
                "-rc", "vbr",
                "-cq", "23",
                "-b:v", "0",
            ] + output_options
            log("尝试 NVENC GPU 硬编渲染……")
            try:
                _run_render_command(nvenc_command, rendered_duration, progress)
                return
            except RuntimeError as err:
                log(f"NVENC 渲染失败，回退 CPU 软编：{err}")
        cpu_command = base_command + [
            "-c:v", "libx264",
            "-preset", "fast",
            "-crf", "23",
        ] + output_options
        _run_render_command(cpu_command, rendered_duration, progress)
    finally:
        try:
            filter_script_path.unlink(missing_ok=True)
        except OSError:
            pass


def _run_render_command(
    command: list[str],
    rendered_duration: float,
    progress: ProgressCallback,
) -> None:
    proc = subprocess.Popen(
        command,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        encoding="utf-8",
        errors="replace",
        creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
    )
    assert proc.stdout is not None
    for line in proc.stdout:
        if line.startswith("out_time_ms="):
            try:
                elapsed = int(line.split("=", 1)[1]) / 1_000_000
                progress(min(0.99, elapsed / max(rendered_duration, 0.001)))
            except ValueError:
                pass
    error = proc.stderr.read() if proc.stderr else ""
    return_code = proc.wait()
    if return_code:
        raise RuntimeError(error or "视频生成失败")
