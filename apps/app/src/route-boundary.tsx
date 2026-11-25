import { Component, type ReactNode } from 'react'
import { Button } from '@stepdoc/ui'

export class RouteBoundary extends Component<
  { children: ReactNode },
  { failed: boolean }
> {
  state = { failed: false }
  static getDerivedStateFromError() {
    return { failed: true }
  }
  render() {
    return this.state.failed ? (
      <>
        <header className="preview-header">
          <nav aria-label="Guide navigation">
            <a href="/" data-sd="route-library">
              Library
            </a>
          </nav>
        </header>
        <main id="main" tabIndex={-1} className="preview-main">
          <h1>Editor unavailable</h1>
          <p>The editor could not load. Reload to try again.</p>
          <Button data-sd="route-reload" onClick={() => location.reload()}>
            Reload editor
          </Button>
        </main>
      </>
    ) : (
      this.props.children
    )
  }
}
