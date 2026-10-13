// Vercel Serverless Function：为前端直传 Vercel Blob 签发短期上传凭证
// POST /api/client-upload  Body: { pathname, contentType }
// 前端用 @vercel/blob/client 的 upload() 直传视频文件（不占用 Serverless 4.5MB 请求体上限）
import { generateClientTokenFromReadWriteToken } from '@vercel/blob/client'

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: '只支持 POST' })
  }

  const readWriteToken = process.env.BLOB_READ_WRITE_TOKEN
  if (!readWriteToken) {
    return res.status(500).json({ error: '服务端未配置 BLOB_READ_WRITE_TOKEN（需在 Vercel 创建 Blob 存储并关联本项目）' })
  }

  // @vercel/blob/client 的 upload() 回调此接口时，参数嵌套在 payload 里：
  // { type: "generate-client-token", payload: { pathname, callbackUrl, clientPayload, multipart } }
  // 兼容直接传顶层字段的调用方式
  const { pathname, contentType } = req.body?.payload || req.body || {}
  if (!pathname) {
    return res.status(400).json({ error: '缺少 pathname 参数' })
  }

  try {
    const clientToken = await generateClientTokenFromReadWriteToken({
      token: readWriteToken,
      pathname,
      contentType: contentType || 'video/mp4',
    })
    return res.status(200).json({ clientToken })
  } catch (e) {
    return res.status(500).json({ error: `签发上传凭证失败：${e.message}` })
  }
}
