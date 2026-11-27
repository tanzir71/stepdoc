export const workspace: string
export function runtimeSource(): Promise<string>
export function recordBuild(
  outDir: string,
  browser: string,
  expected: string | undefined,
): Promise<void>
