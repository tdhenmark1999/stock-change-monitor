import type { Metadata } from 'next';
import Link from 'next/link';
import type { ReactNode } from 'react';
import './globals.css';

export const metadata: Metadata = {
  title: 'Stock & Change Monitor',
  description: 'Monitors websites for stock, price and content changes.',
};

const links = [
  { href: '/', label: 'Dashboard' },
  { href: '/monitors', label: 'Monitors' },
  { href: '/history', label: 'History' },
];

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen antialiased">
        <header className="border-b border-line bg-white">
          <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-x-8 gap-y-2 px-4 py-3">
            <Link href="/" className="font-semibold tracking-tight">Stock &amp; Change Monitor</Link>
            <nav aria-label="Main" className="flex gap-1 text-sm">
              {links.map((link) => (
                <Link key={link.href} href={link.href} className="rounded-md px-3 py-1.5 text-muted hover:bg-canvas hover:text-ink">
                  {link.label}
                </Link>
              ))}
            </nav>
          </div>
        </header>
        <main className="mx-auto max-w-6xl px-4 py-6">{children}</main>
      </body>
    </html>
  );
}
