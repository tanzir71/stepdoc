import './globals.css'
import Link from 'next/link'
import { ThemeToggle } from '@/components/theme-toggle'

export const metadata = {
  title: 'StepDoc',
  description: 'Private workflow documentation',
  robots: { index: false, follow: false },
}

export default function Layout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body>
        <header className="topbar">
          <div className="wrap nav">
            <Link className="brand" href="/">
              StepDoc
            </Link>
            <ThemeToggle />
          </div>
        </header>
        {children}
      </body>
    </html>
  )
}
