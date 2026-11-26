// Private isolated-world membership, never a page-controlled attribute/selector.
const hosts = new WeakSet<Node>()
export function ownCaptureUi(host: Element): void {
  hosts.add(host)
}
export function isCaptureUi(node: Node): boolean {
  for (let current: Node | null = node; current; ) {
    if (hosts.has(current)) return true
    current =
      current.parentNode ??
      (current instanceof ShadowRoot ? current.host : null)
  }
  return false
}
export function captureUiMutation(record: MutationRecord): boolean {
  if (isCaptureUi(record.target)) return true
  return (
    record.type === 'childList' &&
    record.addedNodes.length + record.removedNodes.length > 0 &&
    [...record.addedNodes, ...record.removedNodes].every(isCaptureUi)
  )
}
