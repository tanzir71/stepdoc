import type { BrowserContext, Worker } from '@playwright/test'
export function extensionWorker(context: BrowserContext): Promise<Worker>
