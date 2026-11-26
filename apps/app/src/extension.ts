export interface WalkthroughResult {
  guideId: string
  saved: boolean
}
export interface StepDocExtension {
  guideMe(id: string): Promise<void>
  subscribeGuideMe(callback: (result: WalkthroughResult) => void): () => void
}
declare global {
  interface Window {
    stepdocExtension?: StepDocExtension
  }
}
