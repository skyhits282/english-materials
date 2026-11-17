import { db } from './schema'

let probed: Promise<boolean> | undefined

/** 探测 IndexedDB 可用性（结果缓存，全程只探测一次） */
export function isStorageAvailable(): Promise<boolean> {
  probed ??= (async () => {
    try {
      await db.open()
      return db.isOpen()
    } catch {
      return false
    }
  })()
  return probed
}
