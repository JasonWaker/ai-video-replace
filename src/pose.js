// 骨架动作提取（纯浏览器端 MediaPipe Pose）→ 火柴人参考视频渲染
// 用途：把用户原视频的真人动作转成"黑底白骨架"视频作为 Seedance 的 reference_video，
// 既锁定动作节奏，又规避平台对真人肖像/内容的审核。
import { FilesetResolver, PoseLandmarker } from '@mediapipe/tasks-vision'

// MediaPipe Pose 33 点中用于火柴人的骨架连接（不含面部细节）
const BONES = [
  [11, 12], // 肩线
  [11, 13], [13, 15], // 左臂
  [12, 14], [14, 16], // 右臂
  [11, 23], [12, 24], [23, 24], // 躯干
  [23, 25], [25, 27], [27, 31], // 左腿
  [24, 26], [26, 28], [28, 32], // 右腿
]

let landmarkerPromise = null
async function getLandmarker() {
  if (!landmarkerPromise) {
    landmarkerPromise = (async () => {
      const fileset = await FilesetResolver.forVisionTasks('/mediapipe/wasm')
      const opts = (delegate) => ({
        baseOptions: { modelAssetPath: '/mediapipe/pose_landmarker_lite.task', delegate },
        runningMode: 'IMAGE',
        numPoses: 1,
        minPoseDetectionConfidence: 0.3,
      })
      try {
        return await PoseLandmarker.createFromOptions(fileset, opts('GPU'))
      } catch {
        return await PoseLandmarker.createFromOptions(fileset, opts('CPU'))
      }
    })()
  }
  return landmarkerPromise
}

function seekTo(video, t) {
  return new Promise((resolve) => {
    const on = () => {
      video.removeEventListener('seeked', on)
      resolve()
    }
    video.addEventListener('seeked', on)
    video.currentTime = t
  })
}

function drawStickman(ctx, W, H, lm) {
  ctx.fillStyle = '#000'
  ctx.fillRect(0, 0, W, H)
  // 地面参考线
  ctx.strokeStyle = '#222'
  ctx.lineWidth = Math.max(1, W / 400)
  ctx.beginPath()
  ctx.moveTo(W * 0.08, H * 0.96)
  ctx.lineTo(W * 0.92, H * 0.96)
  ctx.stroke()
  if (!lm) return
  const pt = (i) => ({ x: lm[i].x * W, y: lm[i].y * H, v: lm[i].visibility ?? 1 })
  ctx.strokeStyle = '#fff'
  ctx.lineWidth = Math.max(2, W / 90)
  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'
  for (const [a, b] of BONES) {
    const p1 = pt(a)
    const p2 = pt(b)
    if (p1.v < 0.3 || p2.v < 0.3) continue
    ctx.beginPath()
    ctx.moveTo(p1.x, p1.y)
    ctx.lineTo(p2.x, p2.y)
    ctx.stroke()
  }
  // 头部：以鼻子为圆心，两耳距离估算半径
  const nose = pt(0)
  const earL = pt(7)
  const earR = pt(8)
  const r = Math.max(W / 40, Math.hypot(earL.x - earR.x, earL.y - earR.y) * 0.75)
  if (nose.v > 0.3) {
    ctx.beginPath()
    ctx.arc(nose.x, nose.y, r, 0, Math.PI * 2)
    ctx.fillStyle = '#fff'
    ctx.fill()
  }
}

/**
 * 从视频提取人体骨架并渲染成火柴人视频
 * @param video HTMLVideoElement（已加载元数据）
 * @returns {blob, ext, frames, fps}  失败抛错
 */
export async function extractSkeletonVideo(video, { fps = 15, onProgress } = {}) {
  const duration = video.duration
  if (!duration || !isFinite(duration)) throw new Error('视频时长不可用')
  const total = Math.max(4, Math.min(300, Math.floor(duration * fps)))

  // Seedance 2.0 r2v 要求参考视频像素数 ≥ 407936（≈640×637）；用 540×960=518400 稳过
  const landscape = video.videoWidth >= video.videoHeight
  const W = landscape ? 960 : 540
  const H = landscape ? 540 : 960
  const canvas = document.createElement('canvas')
  canvas.width = W
  canvas.height = H
  const ctx = canvas.getContext('2d')

  // 1) 逐帧骨架推理
  const landmarker = await getLandmarker()
  const frames = []
  for (let i = 0; i < total; i++) {
    const t = Math.min(duration - 0.05, (i / total) * duration)
    await seekTo(video, t)
    let lm = null
    try {
      lm = landmarker.detect(video).landmarks?.[0] || null
    } catch {
      lm = null
    }
    frames.push(lm)
    onProgress?.(i + 1, total)
  }
  // 缺检帧用最近一帧补齐，避免火柴人闪烁消失
  let last = null
  for (let i = 0; i < frames.length; i++) {
    if (frames[i]) last = frames[i]
    else frames[i] = last
  }

  // 2) canvas 逐帧绘制 + MediaRecorder 录制（优先 mp4，退 webm）
  const mime =
    ['video/mp4;codecs=avc1.42E01E', 'video/mp4', 'video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm']
      .find((m) => window.MediaRecorder?.isTypeSupported?.(m)) || ''
  const stream = canvas.captureStream(fps)
  const rec = new MediaRecorder(stream, mime ? { mimeType: mime, videoBitsPerSecond: 2500000 } : undefined)
  const chunks = []
  rec.ondataavailable = (e) => e.data.size && chunks.push(e.data)
  const stopped = new Promise((r) => (rec.onstop = r))
  rec.start()

  let fi = 0
  await new Promise((resolve) => {
    const iv = setInterval(() => {
      drawStickman(ctx, W, H, frames[fi] || null)
      fi++
      if (fi >= frames.length) {
        clearInterval(iv)
        resolve()
      }
    }, 1000 / fps)
  })
  // 等一拍让最后一帧进流
  await new Promise((r) => setTimeout(r, 200))
  rec.stop()
  await stopped

  const type = rec.mimeType || mime || 'video/webm'
  const ext = type.includes('mp4') ? 'mp4' : 'webm'
  return { blob: new Blob(chunks, { type }), ext, frames: frames.length, fps }
}
