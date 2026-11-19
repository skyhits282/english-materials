/** 手写照片客户端预处理（2026-11-19 规格 §2.3）：canvas 压缩（长边上限、JPEG）→ dataURL。
 *  纯函数（computeTargetSize / dataUrlByteSize）单测覆盖；canvas 编码路径依赖浏览器，浏览器终验覆盖。 */

/** 压缩目标长边（px）：百炼视觉输入的合理分辨率上限 */
export const IMAGE_TARGET_LONG_EDGE = 1280
/** JPEG 编码质量 */
export const IMAGE_JPEG_QUALITY = 0.85
/** 压缩后体积上限（字节，原始字节近似）：超限提示重拍 */
export const IMAGE_MAX_BYTES = 3 * 1024 * 1024

/** 目标尺寸：长边超限 → 等比缩小到长边上限；小图不放大；null = 无需缩放 */
export function computeTargetSize(width: number, height: number): { width: number; height: number } | null {
  const longEdge = Math.max(width, height)
  if (longEdge <= IMAGE_TARGET_LONG_EDGE) return null
  const scale = IMAGE_TARGET_LONG_EDGE / longEdge
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) }
}

/** dataURL 字节量近似（base64 部分长度 × 3/4）：体积上限判定用。
 *  含 padding 时略高估（≤2 字节），对上限判定偏保守；假设载荷为 base64（当前唯一调用方是 canvas JPEG dataURL）。 */
export function dataUrlByteSize(dataUrl: string): number {
  const comma = dataUrl.indexOf(',')
  const base64 = comma >= 0 ? dataUrl.slice(comma + 1) : dataUrl
  return Math.floor((base64.length * 3) / 4)
}

/** 图片文件 → 压缩 JPEG dataURL。失败（非图片/解码失败/超限）抛中文 Error，由页面展示。 */
export async function compressImageFile(file: File): Promise<string> {
  if (!file.type.startsWith('image/')) throw new Error('请选择图片文件')
  const dataUrl = await readAsDataUrl(file)
  const img = await loadImage(dataUrl)
  if (img.naturalWidth === 0 || img.naturalHeight === 0) throw new Error('图片解码失败，请重选')
  const target = computeTargetSize(img.naturalWidth, img.naturalHeight)
  const canvas = document.createElement('canvas')
  canvas.width = target?.width ?? img.naturalWidth
  canvas.height = target?.height ?? img.naturalHeight
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('图片处理失败，请重试')
  // 透明 PNG 拍照场景不会出现，但兜底铺白底，避免 JPEG 把透明区编码成黑色
  ctx.fillStyle = '#fff'
  ctx.fillRect(0, 0, canvas.width, canvas.height)
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height)
  const out = canvas.toDataURL('image/jpeg', IMAGE_JPEG_QUALITY)
  if (dataUrlByteSize(out) > IMAGE_MAX_BYTES) throw new Error('图片过大，请离近一些、只拍纸面后重试')
  return out
}

function readAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = () => reject(new Error('图片读取失败，请重选'))
    reader.onabort = () => reject(new Error('图片读取已取消，请重选'))
    reader.readAsDataURL(file)
  })
}

function loadImage(dataUrl: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => resolve(img)
    img.onerror = () => reject(new Error('图片解码失败，请重选'))
    img.src = dataUrl
  })
}
