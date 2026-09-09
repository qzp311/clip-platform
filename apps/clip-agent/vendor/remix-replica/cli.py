from __future__ import annotations

import argparse
import sys
from pathlib import Path

# Windows 嵌入版 Python 的 .pth 不会自动加入脚本目录，手动确保同级 matcher.py 可 import
sys.path.insert(0, str(Path(__file__).parent))

from matcher import analyze, load_analysis, render


def emit_progress(value: float) -> None:
    print(f"PROGRESS:{value:.6f}", flush=True)


def main() -> None:
    parser = argparse.ArgumentParser(description="短剧跑量素材复刻器后端")
    subparsers = parser.add_subparsers(dest="command", required=True)
    analyze_parser = subparsers.add_parser("analyze")
    analyze_parser.add_argument("--reference", action="append", required=True)
    analyze_parser.add_argument("--source", action="append", required=True)
    analyze_parser.add_argument("--output", required=True)
    analyze_parser.add_argument("--sample-fps", type=float, default=4.0)
    analyze_parser.add_argument("--cache-dir", default=None)
    analyze_parser.add_argument("--feature-cache", default=None)
    render_parser = subparsers.add_parser("render")
    render_parser.add_argument("--timeline", required=True)
    render_parser.add_argument("--output-video", required=True)
    render_parser.add_argument("--black-unmatched", action="store_true")
    render_parser.add_argument("--source-only", action="store_true")
    render_parser.add_argument("--source-audio", action="store_true")
    args = parser.parse_args()

    if args.command == "analyze":
        result = analyze(
            args.reference,
            args.source,
            args.output,
            lambda text: print(text, flush=True),
            emit_progress,
            sample_fps=args.sample_fps,
            cache_dir=args.cache_dir,
            feature_cache_path=args.feature_cache,
        )
        print(f"RESULT:MATCHED={result.matched_seconds:.3f};UNMATCHED={result.unmatched_seconds:.3f}", flush=True)
    else:
        result = load_analysis(args.timeline)
        render(
            result,
            args.output_video,
            not args.black_unmatched,
            args.source_only,
            args.source_audio,
            lambda text: print(text, flush=True),
            emit_progress,
        )
        print(f"RESULT:VIDEO={Path(args.output_video).resolve()}", flush=True)


if __name__ == "__main__":
    main()
