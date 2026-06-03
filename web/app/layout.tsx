import type { ReactNode } from 'react'

export const metadata = {
  title: 'compost',
  description: 'Local-first, AI-first research analysis harness',
}

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <header style={{ borderBottom: '1px solid #eee', padding: '0.75rem 1rem' }}>
          <strong>compost</strong> · local research analysis
        </header>
        <main style={{ padding: '1rem' }}>{children}</main>
      </body>
    </html>
  )
}
