// 自定义舞蹈模板库（存在 Vercel Blob，所有用户共享）
// GET /api/dances → 返回自定义舞蹈列表
// POST /api/dances → 新增 { name, desc }

import { put, list } from '@vercel/blob'

const BLOB_PATH = 'custom-dances.json'

async function readDances() {
  try {
    const { blobs } = await list({ prefix: BLOB_PATH })
    if (!blobs.length) return []
    const res = await fetch(blobs[0].url)
    return await res.json()
  } catch {
    return []
  }
}

export default async function handler(req, res) {
  if (req.method === 'GET') {
    try {
      const dances = await readDances()
      return res.status(200).json({ dances })
    } catch (e) {
      return res.status(500).json({ error: e.message })
    }
  }

  if (req.method === 'POST') {
    try {
      const { name, desc } = req.body || {}
      if (!name || !name.trim()) {
        return res.status(400).json({ error: '舞蹈名不能为空' })
      }
      const dances = await readDances()
      // 重名检查
      if (dances.some(d => d.name === name.trim())) {
        return res.status(400).json({ error: '已存在同名舞蹈' })
      }
      dances.push({ name: name.trim(), desc: (desc || '').trim() || '随节奏卡点舞动' })
      // 写回 Blob（overwrite）
      await put(BLOB_PATH, JSON.stringify(dances, null, 2), {
        access: 'public',
        contentType: 'application/json',
        allowOverwrite: true,
      })
      return res.status(200).json({ dances })
    } catch (e) {
      return res.status(500).json({ error: e.message })
    }
  }

  res.status(405).json({ error: 'Method not allowed' })
}
