"""Seedance 视频生成核心封装：创建任务、轮询状态、下载结果。"""

from __future__ import annotations

import os
import time
from pathlib import Path
from typing import Any

from arkruntime import Ark
import requests


ARK_BASE_URL = "https://ark.cn-beijing.volces.com/api/v3"


def get_client(api_key: str | None = None) -> Ark:
    """初始化 Ark 客户端，优先用传入的 key，否则读环境变量 ARK_API_KEY。"""
    key = api_key or os.environ.get("ARK_API_KEY")
    if not key:
        raise RuntimeError("未找到 ARK_API_KEY，请设置环境变量或在调用时传入 api_key 参数")
    return Ark(api_key=key, base_url=ARK_BASE_URL)


def create_text2video_task(
    prompt: str,
    *,
    model: str = "doubao-seedance-2-5-260628",
    duration: int = 5,
    ratio: str = "adaptive",
    generate_audio: bool = True,
    watermark: bool = False,
    api_key: str | None = None,
) -> str:
    """创建一个纯文生视频任务，返回 task_id。"""
    client = get_client(api_key)
    resp = client.content_generation.tasks.create(
        model=model,
        content=[{"text": prompt, "type": "text"}],
        duration=duration,
        ratio=ratio,
        generate_audio=generate_audio,
        watermark=watermark,
    )
    task_id = _extract_task_id(resp)
    if not task_id:
        raise RuntimeError(f"创建任务失败，返回值：{resp}")
    print(f"✓ 任务已创建：{task_id}")
    return task_id


def create_image2video_task(
    image_url: str,
    prompt: str = "",
    *,
    model: str = "doubao-seedance-2-5-260628",
    duration: int = 5,
    ratio: str = "adaptive",
    generate_audio: bool = True,
    watermark: bool = False,
    api_key: str | None = None,
) -> str:
    """图生视频：以图片为参考（首帧或风格），可选加文本提示词。返回 task_id。"""
    client = get_client(api_key)
    content: list[dict[str, Any]] = [
        {"image_url": {"url": image_url}, "type": "image_url"},
    ]
    if prompt:
        content.insert(0, {"text": prompt, "type": "text"})

    resp = client.content_generation.tasks.create(
        model=model,
        content=content,
        duration=duration,
        ratio=ratio,
        generate_audio=generate_audio,
        watermark=watermark,
    )
    task_id = _extract_task_id(resp)
    if not task_id:
        raise RuntimeError(f"创建任务失败，返回值：{resp}")
    print(f"✓ 任务已创建：{task_id}")
    return task_id


def wait_and_download(
    task_id: str,
    output_dir: str | Path = "output",
    *,
    poll_interval: int = 10,
    max_wait: int = 600,
    api_key: str | None = None,
) -> Path:
    """轮询任务直到完成/失败，成功后下载视频到 output_dir，返回本地文件路径。"""
    client = get_client(api_key)
    output_dir = Path(output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)

    print(f"⟳ 轮询任务 {task_id}（每 {poll_interval}s 一次，最长 {max_wait}s）…")
    start = time.time()
    while True:
        elapsed = time.time() - start
        if elapsed > max_wait:
            raise TimeoutError(f"任务 {task_id} 在 {max_wait}s 内未完成")

        resp = client.content_generation.tasks.get(task_id=task_id)
        status = _get_field(resp, "status")
        print(f"  [{int(elapsed)}s] 状态：{status}")

        if status == "succeeded":
            break
        if status in ("failed", "expired", "canceled"):
            error_msg = _get_field(resp, "error")
            raise RuntimeError(f"任务 {task_id} 失败：{error_msg}")

        time.sleep(poll_interval)

    # 拿到视频 URL 并下载
    video_url = _extract_video_url(resp)
    if not video_url:
        raise RuntimeError(f"任务成功但未找到视频 URL，原始响应：{resp}")

    file_path = output_dir / f"{task_id}.mp4"
    print(f"⬇ 下载视频 → {file_path}")
    r = requests.get(video_url, stream=True, timeout=120)
    r.raise_for_status()
    with open(file_path, "wb") as f:
        for chunk in r.iter_content(chunk_size=8192):
            f.write(chunk)
    print(f"✓ 完成：{file_path}")
    return file_path


def _extract_video_url(resp: Any) -> str | None:
    """从 task get 响应里抠出视频 URL。响应格式可能是对象或 dict，兼容处理。"""
    # 尝试常见字段路径
    candidates = []
    if isinstance(resp, dict):
        candidates.append(resp.get("content"))
        candidates.append(resp.get("result"))
    else:
        candidates.append(getattr(resp, "content", None))
        candidates.append(getattr(resp, "result", None))

    for container in candidates:
        if not container:
            continue
        items = container if isinstance(container, list) else [container]
        for item in items:
            if isinstance(item, dict):
                url = item.get("video_url") or item.get("url")
                if url and ("http" in url):
                    return url
            else:
                # SDK 对象
                url = getattr(item, "video_url", None) or getattr(item, "url", None)
                if url and ("http" in url):
                    return url
    return None


def _get_field(resp: Any, field: str, default: Any = None) -> Any:
    """从 SDK 响应对象或 dict 里取字段，兼容两种返回类型。"""
    if isinstance(resp, dict):
        return resp.get(field, default)
    return getattr(resp, field, default)


def _extract_task_id(resp: Any) -> str | None:
    """从 create 响应里提取 task id。"""
    tid = _get_field(resp, "id")
    if tid and isinstance(tid, str):
        return tid
    return None
