import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import {
  Avatar,
  Badge,
  Button,
  Checkbox,
  ClickMarker,
  IconButton,
  Input,
  Kbd,
  Logo,
  NavItem,
  SegmentGroup,
  StepPin,
  StepRow,
  Toggle,
} from '@stepdoc/ui'
import '@stepdoc/ui/styles.css'

function Gallery() {
  const [on, toggle] = useState(false)
  const [checked, check] = useState(false)
  const [segment, select] = useState('first')
  return (
    <>
      <header>
        <Logo />
        <h1>Component verification</h1>
      </header>
      <nav aria-label="Component examples">
        <NavItem href="#main" data-sd="gallery-nav" icon="grid" active>
          Library
        </NavItem>
      </nav>
      <main id="main">
        <section aria-label="Buttons">
          {(['primary', 'secondary', 'ghost', 'danger'] as const).flatMap(
            (kind) =>
              (['m', 's'] as const).map((size) => (
                <Button
                  key={`${kind}-${size}`}
                  kind={kind}
                  size={size}
                  icon="plus"
                  data-sd={`gallery-button-${kind}-${size}`}
                >
                  {kind} {size}
                </Button>
              )),
          )}
          <IconButton
            icon="more"
            aria-label="More actions"
            data-sd="gallery-icon-button"
          />
        </section>
        <section aria-label="Badges">
          {(
            [
              'neutral',
              'accent',
              'success',
              'warning',
              'danger',
              'agent',
            ] as const
          ).map((tone) => (
            <Badge key={tone} tone={tone}>
              {tone}
            </Badge>
          ))}
          <Badge showDot={false}>No dot</Badge>
        </section>
        <section aria-label="Inputs">
          <Input
            label="Example field"
            placeholder="Type a label"
            data-sd="gallery-input"
          />
          <Toggle
            on={on}
            onChange={toggle}
            aria-label="Example toggle"
            data-sd="gallery-toggle"
          />
          <Checkbox
            checked={checked}
            onChange={(event) => check(event.target.checked)}
            aria-label="Example checkbox"
            data-sd="gallery-checkbox"
          />
          <Kbd>Ctrl K</Kbd>
        </section>
        <section aria-label="Segments">
          <SegmentGroup
            value={segment}
            onChange={select}
            options={[
              { value: 'first', label: 'First' },
              { value: 'second', label: 'Second' },
            ]}
            label="Example segments"
            controls="gallery-panel"
            hook="gallery-segment"
          />
          <div
            id="gallery-panel"
            role="tabpanel"
            aria-labelledby={`gallery-segment-${segment}`}
          >
            {segment}
          </div>
        </section>
        <section aria-label="Steps">
          {(['default', 'active', 'flagged'] as const).map((state, index) => (
            <StepRow
              key={state}
              number={String(index + 1)}
              state={state}
              title="Open settings"
              meta="Click · button"
              data-sd={`gallery-step-${state}`}
            />
          ))}
          <ClickMarker />
          <StepPin>1</StepPin>
          <Avatar initials="YO" />
        </section>
      </main>
      <footer>Local component fixture</footer>
    </>
  )
}
createRoot(document.getElementById('root')!).render(<Gallery />)
