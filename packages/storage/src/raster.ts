import { StorageError, type BlobUpload } from './adapter'

export const MAX_BLOB_BYTES = 64 * 1024 * 1024
/** Transport validation only. Callers must redact/flatten pixels beforehand. */
export async function validateBlob(
  upload: BlobUpload,
  maximum = MAX_BLOB_BYTES,
): Promise<Blob> {
  if (
    !upload ||
    typeof upload.stepId !== 'string' ||
    !upload.stepId ||
    !['original', 'rendered', 'thumb'].includes(upload.kind) ||
    !(upload.file instanceof Blob) ||
    !upload.file.size ||
    upload.file.size > maximum
  )
    throw new StorageError('invalid_blob')
  const file = upload.file
  const bytes = new Uint8Array(await file.slice(0, 12).arrayBuffer())
  const png =
    file.type === 'image/png' &&
    [137, 80, 78, 71, 13, 10, 26, 10].every(
      (value, index) => bytes[index] === value,
    )
  const webp =
    file.type === 'image/webp' &&
    bytes[0] === 82 &&
    bytes[1] === 73 &&
    bytes[2] === 70 &&
    bytes[3] === 70 &&
    bytes[8] === 87 &&
    bytes[9] === 69 &&
    bytes[10] === 66 &&
    bytes[11] === 80
  if (!png && !webp) throw new StorageError('invalid_blob')
  return file
}
