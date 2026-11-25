import { useEffect, useId, useState, type ReactNode } from 'react'
import { Input, Icon, type IconName } from '@stepdoc/ui'

export function TextField({
  label,
  value,
  onChange,
  hook,
  multiline = false,
  required = false,
  maxLength = 5000,
  className = '',
  disabled = false,
}: {
  label: string
  value: string
  onChange: (value: string) => void
  hook: string
  multiline?: boolean
  required?: boolean
  maxLength?: number
  className?: string
  disabled?: boolean
}) {
  const [text, setText] = useState(value)
  useEffect(() => setText(value), [value])
  const invalid = required && !text.trim()
  const input = {
    value: text,
    required,
    maxLength,
    disabled,
    'aria-invalid': invalid || undefined,
    'data-sd': hook,
    onChange: (
      event: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>,
    ) => {
      setText(event.target.value)
      if (!required || event.target.value.trim()) onChange(event.target.value)
    },
  }
  return multiline ? (
    <label className={`sd-input editor-field ${className}`}>
      <span className="sd-input-label">{label}</span>
      <textarea {...input} rows={3} />
    </label>
  ) : (
    <Input {...input} label={label} className={`editor-field ${className}`} />
  )
}
export function SelectField({
  icon,
  label,
  value,
  onChange,
  hook,
  children,
}: {
  icon?: IconName
  label: string
  value: string
  onChange: (value: string) => void
  hook: string
  children: ReactNode
}) {
  const id = useId()
  return (
    <label className="sd-input editor-field" htmlFor={id}>
      <span className="sd-input-label">{label}</span>
      <span
        className={icon ? 'sd-select-control has-icon' : 'sd-select-control'}
      >
        {icon ? <Icon name={icon} /> : null}
        <select
          id={id}
          value={value}
          data-sd={hook}
          onChange={(event) => onChange(event.target.value)}
        >
          {children}
        </select>
        {icon ? (
          <Icon name="editor-chevron-down" className="select-chevron" />
        ) : null}
      </span>
    </label>
  )
}
