import { SegmentGroup, Icon, Button } from '@stepdoc/ui'
import type { PairingState } from '@stepdoc/schema/pairing'
import type {
  CaptureDestination,
  ServerDestination,
} from '@stepdoc/schema/capture-destination'
import { serverLabel } from './destination-view'

export function pairedDestination(
  state: PairingState | null,
): ServerDestination | null {
  return state?.generation &&
    state.connection &&
    state.connection.status !== 'revoked' &&
    !state.pending
    ? {
        kind: 'server',
        server: state.connection.server,
        deviceId: state.connection.deviceId,
        generation: state.generation,
      }
    : null
}
export function sameDestination(
  left: CaptureDestination,
  right: CaptureDestination | null,
): boolean {
  if (!right || left.kind !== right.kind) return false
  return (
    left.kind === 'browser' ||
    (right.kind === 'server' &&
      left.server === right.server &&
      left.generation === right.generation &&
      left.deviceId === right.deviceId)
  )
}
export function CaptureDestinationPicker({
  choice,
  paired,
  reviewing,
  disabled,
  onChange,
}: {
  choice: CaptureDestination
  paired: ServerDestination | null
  reviewing: boolean
  disabled: boolean
  onChange: (choice: CaptureDestination) => void
}) {
  const stale = choice.kind === 'server' && !sameDestination(choice, paired)
  if (!reviewing && !paired)
    return (
      <div className="capture-destination-picker">
        <span>Selected server is unavailable</span>
        <Button
          kind="secondary"
          size="s"
          disabled={disabled}
          data-sd="capture-destination-browser"
          onClick={() => onChange({ kind: 'browser' })}
        >
          Use this browser
        </Button>
      </div>
    )
  return reviewing ? (
    <div className="capture-destination capture-save-destination">
      <label htmlFor="capture-destination-select">Save to</label>
      <div className="capture-destination-select">
        <select
          id="capture-destination-select"
          data-sd="capture-destination"
          aria-label="Save to"
          value={stale ? 'stale' : choice.kind}
          disabled={disabled}
          onChange={(event) => {
            if (event.target.value === 'browser') onChange({ kind: 'browser' })
            else if (paired) onChange(paired)
          }}
        >
          {stale ? (
            <option value="stale" disabled>
              Choose destination again
            </option>
          ) : null}
          <option value="browser">This browser</option>
          {paired ? (
            <option value="server">{serverLabel(paired)}</option>
          ) : null}
        </select>
        <Icon name="capture-destination-chevron" />
      </div>
    </div>
  ) : (
    <div className="capture-destination-picker">
      <span>Save captures to</span>
      <SegmentGroup
        value={choice.kind}
        options={[
          { value: 'browser' as const, label: 'This browser' },
          ...(paired
            ? [{ value: 'server' as const, label: serverLabel(paired) }]
            : choice.kind === 'server'
              ? [{ value: 'server' as const, label: 'Server unavailable' }]
              : []),
        ]}
        label="Save captures to"
        hook="capture-destination"
        controls="capture-start-content"
        disabled={disabled}
        onChange={(value) => {
          if (value === 'browser') onChange({ kind: 'browser' })
          else if (paired) onChange(paired)
        }}
      />
    </div>
  )
}
