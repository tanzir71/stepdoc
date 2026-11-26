export const phpRoot: string
export function phpRuntime(): { binary: string; args: string[] }
export function dependencies(runtime?: {
  binary: string
  args: string[]
}): Promise<void>
