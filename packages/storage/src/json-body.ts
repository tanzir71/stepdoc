import { StorageError, type StorageErrorCode } from './adapter'

/** Count escaped UTF-8 JSON before allocating a potentially oversized body. */
export function jsonBody(
  value: unknown,
  maximum: number,
  code: StorageErrorCode = 'invalid_guide',
): string {
  let size = 0
  const active = new Set<object>()
  const add = (bytes: number) => {
    size += bytes
    if (size > maximum) throw new StorageError(code)
  }
  const string = (text: string) => {
    add(2)
    // Base64 and most capture text need only their ASCII length.
    if (/^[\x20-\x21\x23-\x5b\x5d-\x7f]*$/.test(text)) {
      add(text.length)
      return
    }
    for (let i = 0; i < text.length; i++) {
      const char = text.charCodeAt(i)
      if (char === 34 || char === 92) add(2)
      else if (char < 32) add([8, 9, 10, 12, 13].includes(char) ? 2 : 6)
      else if (char < 128) add(1)
      else if (char < 2048) add(2)
      else if (char >= 0xd800 && char <= 0xdfff) {
        const next = text.charCodeAt(i + 1)
        if (char <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) {
          add(4)
          i++
        } else add(6)
      } else add(3)
    }
  }
  const visit = (item: unknown, depth: number) => {
    if (depth > 64) throw new StorageError('invalid_guide')
    if (item === null) add(4)
    else if (typeof item === 'string') string(item)
    else if (typeof item === 'boolean') add(item ? 4 : 5)
    else if (typeof item === 'number' && Number.isFinite(item))
      add(String(item).length)
    else if (typeof item === 'object') {
      const prototype = Object.getPrototypeOf(item)
      if (
        (Array.isArray(item)
          ? prototype !== Array.prototype
          : prototype !== Object.prototype && prototype !== null) ||
        'toJSON' in item
      )
        throw new StorageError('invalid_guide')
      if (active.has(item)) throw new StorageError('invalid_guide')
      active.add(item)
      add(2)
      let count = 0
      if (Array.isArray(item)) {
        for (const child of item) {
          if (count++) add(1)
          visit(child === undefined ? null : child, depth + 1)
        }
      } else {
        for (const [key, child] of Object.entries(item)) {
          if (child === undefined) continue
          if (count++) add(1)
          string(key)
          add(1)
          visit(child, depth + 1)
        }
      }
      active.delete(item)
    } else throw new StorageError('invalid_guide')
  }
  try {
    visit(value, 0)
    return JSON.stringify(value)
  } catch (error) {
    if (error instanceof StorageError) throw error
    throw new StorageError('invalid_guide')
  }
}
