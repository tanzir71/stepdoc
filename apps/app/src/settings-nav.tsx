import { Icon, NavItem, type IconName } from '@stepdoc/ui'
import { appHref } from './app-url'

const sections = [
  ['General', 'general'],
  ['Members & sign-in', 'members'],
  ['Devices & tokens', 'devices'],
  ['Storage & deploy', 'storage'],
  ['Publishing', 'publishing'],
  ['AI providers', 'ai'],
  ['Redaction policy', 'redaction'],
  ['Branding', 'branding'],
  ['Agent access', 'agent'],
  ['Audit log', 'audit'],
] as const
export function SettingsNav({ current }: { current: 'general' | 'devices' }) {
  return (
    <nav className="settings-nav" aria-label="Settings">
      <h2>Settings</h2>
      {sections.map(([label, key]) =>
        key === 'general' || key === 'devices' ? (
          <NavItem
            key={key}
            href={appHref('/settings/' + key)}
            active={current === key}
            icon={`settings-${key}`}
            data-sd={`settings-nav-${key}`}
          >
            {label}
          </NavItem>
        ) : (
          <button
            key={key}
            type="button"
            disabled
            className="settings-unavailable"
            title="Unavailable for this workspace"
          >
            <Icon name={`settings-${key}` as IconName} />
            {label}
          </button>
        ),
      )}
    </nav>
  )
}
