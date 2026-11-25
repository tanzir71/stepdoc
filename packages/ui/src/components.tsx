import {
  useId,
  useRef,
  type ButtonHTMLAttributes,
  type CSSProperties,
  type InputHTMLAttributes,
  type ReactNode,
  type Ref,
} from 'react'
import {
  defaultThumb,
  icons,
  logoMark,
  logoMarkDark,
  toggleOff,
  toggleOn,
  type IconName,
} from './assets'

type Hook = { 'data-sd': string }
const classes = (...values: Array<string | undefined | false>) =>
  values.filter(Boolean).join(' ')

export function Icon({
  name,
  className,
}: {
  name: IconName
  className?: string
}) {
  const asset = icons[name]
  return (
    <span
      aria-hidden="true"
      className={classes('sd-icon', className)}
      data-asset={name}
      style={
        {
          width: asset.width,
          height: asset.height,
          '--sd-icon-image': `url("${asset.url}")`,
        } as CSSProperties
      }
    />
  )
}
export interface ButtonProps
  extends ButtonHTMLAttributes<HTMLButtonElement>,
    Hook {
  kind?: 'primary' | 'secondary' | 'ghost' | 'danger'
  size?: 'm' | 's'
  icon?: IconName
  label?: string
  showIcon?: boolean
  children?: ReactNode
}
export function Button({
  kind = 'primary',
  size = 'm',
  icon,
  showIcon = true,
  label,
  children,
  className,
  type = 'button',
  ...props
}: ButtonProps) {
  return (
    <button
      {...props}
      type={type}
      className={classes('sd-button', className)}
      data-kind={kind}
      data-size={size}
    >
      {icon && showIcon ? (
        <Icon name={size === 's' && icon === 'plus' ? 'plus-small' : icon} />
      ) : null}
      {children ?? label}
    </button>
  )
}
export interface IconButtonProps
  extends Omit<ButtonProps, 'children' | 'kind' | 'icon'> {
  icon: IconName
  kind?: 'ghost' | 'secondary'
  'aria-label': string
}
export function IconButton({
  icon,
  kind = 'ghost',
  className,
  ...props
}: IconButtonProps) {
  return (
    <Button
      {...props}
      kind={kind}
      className={classes('sd-icon-button', className)}
    >
      <Icon name={icon} />
    </Button>
  )
}
export function Badge({
  tone = 'neutral',
  dot = true,
  showDot,
  label = 'Badge',
  children,
  className,
}: {
  tone?: 'neutral' | 'accent' | 'success' | 'warning' | 'danger' | 'agent'
  dot?: boolean
  showDot?: boolean
  label?: string
  children?: ReactNode
  className?: string
}) {
  return (
    <span className={classes('sd-badge', className)} data-tone={tone}>
      {(showDot ?? dot) ? <Icon name="dot" /> : null}
      {children ?? label}
    </span>
  )
}
export function Kbd({ children }: { children: ReactNode }) {
  return <kbd className="sd-kbd">{children}</kbd>
}
export interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  label: string
  icon?: IconName
  state?: 'default' | 'focus'
  ref?: Ref<HTMLInputElement>
  'data-sd': string
}
export function Input({
  label,
  id,
  icon,
  state = 'default',
  className,
  ref,
  ...props
}: InputProps) {
  const generated = useId()
  const fieldId = id ?? generated
  return (
    <label
      className={classes('sd-input', className)}
      htmlFor={fieldId}
      data-state={state}
    >
      <span className="sd-input-label">{label}</span>
      <span className="sd-input-field">
        {icon ? <Icon name={icon} /> : null}
        <input {...props} id={fieldId} ref={ref} />
      </span>
    </label>
  )
}
export function Toggle({
  on,
  onChange,
  'aria-label': label,
  ...props
}: Hook & {
  on: boolean
  onChange: (on: boolean) => void
  'aria-label': string
  disabled?: boolean
}) {
  return (
    <button
      {...props}
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      className="sd-toggle"
      onClick={() => onChange(!on)}
    >
      <img src={on ? toggleOn : toggleOff} alt="" width={32} height={18} />
    </button>
  )
}
export interface CheckboxProps
  extends Omit<
      InputHTMLAttributes<HTMLInputElement>,
      'type' | 'size' | 'defaultChecked'
    >,
    Hook {
  checked: boolean
  'aria-label': string
}
export function Checkbox({ className, checked, ...props }: CheckboxProps) {
  return (
    <span className={classes('sd-checkbox', className)}>
      <input {...props} checked={checked} type="checkbox" />
      <span aria-hidden="true" className="sd-checkbox-visual">
        {checked ? <Icon name="check" /> : null}
      </span>
    </span>
  )
}
export function Segment({
  selected,
  children,
  className,
  ...props
}: Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'role'> &
  Hook & { selected: boolean; children: ReactNode }) {
  return (
    <button
      {...props}
      type="button"
      role="tab"
      aria-selected={selected}
      tabIndex={selected ? 0 : -1}
      className={classes('sd-segment', className)}
    >
      {children}
    </button>
  )
}
export function SegmentGroup<T extends string>({
  value,
  options,
  onChange,
  label,
  controls,
  hook,
}: {
  value: T
  options: ReadonlyArray<{ value: T; label: string }>
  onChange: (value: T) => void
  label: string
  controls: string
  hook: string
}) {
  const root = useRef<HTMLDivElement>(null)
  const selected = options.findIndex((option) => option.value === value)
  return (
    <div
      ref={root}
      className="sd-segment-group"
      role="tablist"
      aria-label={label}
      onKeyDown={(event) => {
        if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key))
          return
        event.preventDefault()
        const index =
          event.key === 'Home'
            ? 0
            : event.key === 'End'
              ? options.length - 1
              : (selected +
                  (event.key === 'ArrowRight' ? 1 : -1) +
                  options.length) %
                options.length
        const next = options[index]
        if (next) {
          onChange(next.value)
          root.current
            ?.querySelectorAll<HTMLButtonElement>('[role=tab]')
            [index]?.focus()
        }
      }}
    >
      {options.map((option) => (
        <Segment
          key={option.value}
          selected={option.value === value}
          id={`${hook}-${option.value}`}
          aria-controls={controls}
          data-sd={`${hook}-${option.value}`}
          onClick={() => onChange(option.value)}
        >
          {option.label}
        </Segment>
      ))}
    </div>
  )
}
export function NavItem({
  href,
  active = false,
  icon,
  count,
  children,
  className,
  ...props
}: Hook & {
  href: string
  active?: boolean
  icon: IconName
  count?: number
  children: ReactNode
  className?: string
}) {
  return (
    <a
      {...props}
      href={href}
      className={classes('sd-nav-item', className)}
      aria-current={active ? 'page' : undefined}
    >
      <Icon name={icon} />
      <span className="sd-nav-label">{children}</span>
      {count !== undefined ? (
        <span className="sd-nav-count">{count}</span>
      ) : null}
    </a>
  )
}
export interface StepRowProps extends Omit<ButtonProps, 'children'> {
  number: string
  title: string
  meta: string
  state?: 'default' | 'active' | 'flagged'
  thumbnail?: string
}
export function StepRow({
  number,
  title,
  meta,
  state = 'default',
  thumbnail = defaultThumb,
  className,
  ...props
}: StepRowProps) {
  return (
    <Button
      {...props}
      kind="ghost"
      className={classes('sd-step-row', className)}
      aria-current={state === 'active' ? 'step' : undefined}
      data-state={state}
    >
      <span className="sd-step-number">{number}</span>
      <img
        className="sd-step-thumb"
        src={thumbnail}
        alt=""
        width={64}
        height={40}
      />
      <span className="sd-step-copy">
        <span>{title}</span>
        <span className="sd-step-meta">
          {meta}
          {state === 'flagged' ? (
            <Badge tone="warning" dot={false}>
              Review
            </Badge>
          ) : null}
        </span>
      </span>
    </Button>
  )
}
export function ClickMarker() {
  return <Icon name="marker" className="sd-click-marker" />
}
export function StepPin({ children }: { children: ReactNode }) {
  return <span className="sd-step-pin">{children}</span>
}
export function Avatar({ initials }: { initials: string }) {
  return (
    <span className="sd-avatar" aria-hidden="true">
      {initials}
    </span>
  )
}
export function Logo({ markOnly = false }: { markOnly?: boolean }) {
  return (
    <span className="sd-logo">
      <span className="sd-logo-symbol">
        <img
          className="sd-logo-light"
          src={logoMark}
          alt=""
          width={32}
          height={32}
        />
        <img
          className="sd-logo-dark"
          src={logoMarkDark}
          alt=""
          width={24}
          height={24}
        />
      </span>
      {markOnly ? null : <span>stepdoc</span>}
    </span>
  )
}
