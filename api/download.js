// Vercel Edge Function：代理下载生成的视频（流式转发，绕过浏览器跨域限制与 4.5MB 响应限制）
// GET /api/download?url=<视频地址>&filename=<保存文件名>
// 安全限制：仅允许下载可灵 / 火山方舟官方 CDN 域名下的视频，不做通用转发
export const config = { runtime: 'edge' }

const ALLOWED_HOST_SUFFIXES = ['.klingai.com', '.volces.com', '.blob.vercel-storage.com']

function isAllowedHost(hostname) {
  const host = hostname.toLowerCase()
  return ALLOWED_HOST_SUFFIXES.some((suffix) => host.endsWith(suffix))
}

function jsonError(message, status) {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  })
}

export default async function handler(req) {
  const { searchParams } = new URL(req.url)
  const url = searchParams.get('url') || ''
  const filename = (searchParams.get('filename') || 'ai-video.mp4').replace(/[^\w.\-一-龥]/g, '_')

  let target
  try {
    target = new URL(url)
  } catch {
    return jsonError('无效的视频 URL', 400)
  }

  if (target.protocol !== 'https:' || !isAllowedHost(target.hostname)) {
    return jsonError('仅支持下载本平台生成的视频链接', 400)
  }

  let upstream
  try {
    upstream = await fetch(target.toString(), {
      headers: { 'User-Agent': 'Mozilla/5.0 AI-Video-Downloader' },
      redirect: 'follow',
    })
  } catch (e) {
    return jsonError(`拉取视频失败：${e.message}`, 502)
  }

  if (!upstream.ok || !upstream.body) {
    return jsonError(`视频源返回 ${upstream.status}，链接可能已过期`, 502)
  }

  const headers = new Headers()
  headers.set('Content-Type', upstream.headers.get('content-type') || 'video/mp4')
  headers.set('Content-Disposition', `attachment; filename="${filename}"`)
  const len = upstream.headers.get('content-length')
  if (len) headers.set('Content-Length', len)

  return new Response(upstream.body, { status: 200, headers })
}
