export function buildPhp(options?: { output?: string; buildApp?: boolean }): Promise<{
  archive: string
  setupKeyFile: string
  fileCount: number
}>
