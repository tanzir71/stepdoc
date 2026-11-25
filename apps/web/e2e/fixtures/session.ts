/** Shared by the v1 browser suite and guide@1 migration regression tests. */
export function onboardingSession(count = 30) {
  return {
    title: 'Browser onboarding',
    description: 'A complete test guide',
    sourceUrl: 'https://example.com/app',
    steps: Array.from({ length: count }, (_, index) => ({
      position: index,
      type: 'action' as const,
      text: `Complete action ${index + 1}`,
    })),
  }
}
