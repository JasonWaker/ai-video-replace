"""ai-video-replace CLI：文生视频 / 图生视频。

用法示例：
  # 文生视频
  python -m src.cli text "一位穿红裙的女孩在樱花树下跳舞，慢镜头"

  # 图生视频（本地图片或 URL）
  python -m src.cli image ./input/reference.jpg --prompt "女孩在海边奔跑"

  # 仅测试 API key 连通性
  python -m src.cli ping
"""

from __future__ import annotations

import argparse
import os
import sys
from pathlib import Path

# 允许直接 `python -m src.cli` 运行
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from src.seedance_client import (
    create_image2video_task,
    create_text2video_task,
    get_client,
    wait_and_download,
)


def cmd_ping(_args: argparse.Namespace) -> None:
    """测试 API key 是否有效。"""
    api_key = os.environ.get("ARK_API_KEY", "")
    if not api_key:
        print("✗ 未设置 ARK_API_KEY 环境变量")
        sys.exit(1)
    try:
        client = get_client()
        # 试试列一下任务（最轻量的调用）
        _ = client.content_generation.tasks.list(page_size=1)
        print("✓ 火山方舟 API 连通正常")
    except Exception as e:
        print(f"✗ 连通失败：{e}")
        sys.exit(1)


def cmd_text(args: argparse.Namespace) -> None:
    task_id = create_text2video_task(
        args.prompt,
        model=args.model,
        duration=args.duration,
        ratio=args.ratio,
        generate_audio=not args.no_audio,
    )
    wait_and_download(task_id, output_dir=args.output, poll_interval=8)


def cmd_image(args: argparse.Namespace) -> None:
    # 本地图片需要先转成公网可访问 URL 才能给 Seedance 用
    if args.image.startswith("http"):
        image_url = args.image
    else:
        print("⚠ 当前仅支持图片 URL 作为输入，本地图片请先上传到图床/OSS")
        print("  后续会增加本地图片自动上传功能")
        sys.exit(1)

    task_id = create_image2video_task(
        image_url,
        prompt=args.prompt or "",
        model=args.model,
        duration=args.duration,
        ratio=args.ratio,
        generate_audio=not args.no_audio,
    )
    wait_and_download(task_id, output_dir=args.output, poll_interval=8)


def _add_common_args(p: argparse.ArgumentParser) -> None:
    """给每个子命令加上共享参数。"""
    p.add_argument("--model", default="doubao-seedance-2-5-260628", help="Seedance 模型 ID")
    p.add_argument("--duration", type=int, default=5, help="视频时长（秒）")
    p.add_argument("--ratio", default="adaptive", help="画幅比例：adaptive / 16:9 / 9:16 / 1:1")
    p.add_argument("--output", default="output", help="输出目录")
    p.add_argument("--no-audio", action="store_true", help="不生成音频")


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(prog="ai-video-replace", description="Seedance AI 视频生成 CLI")
    sub = p.add_subparsers(dest="command", required=True)

    sp_ping = sub.add_parser("ping", help="测试 API key 连通性")
    sp_ping.set_defaults(func=cmd_ping)

    sp_text = sub.add_parser("text", help="文生视频")
    sp_text.add_argument("prompt", help="视频描述（中文英文均可）")
    _add_common_args(sp_text)
    sp_text.set_defaults(func=cmd_text)

    sp_img = sub.add_parser("image", help="图生视频（图片 URL）")
    sp_img.add_argument("image", help="图片公网 URL")
    sp_img.add_argument("--prompt", default="", help="附加文本提示词（可选）")
    _add_common_args(sp_img)
    sp_img.set_defaults(func=cmd_image)

    return p


def main() -> None:
    parser = build_parser()
    args = parser.parse_args()
    args.func(args)


if __name__ == "__main__":
    main()
