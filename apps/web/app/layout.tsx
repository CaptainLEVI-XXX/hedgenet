import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';
import './mockup.css';
import './app.css';

export const metadata: Metadata = {
  title: 'HedgeNet — Risk, made visible',
  description: 'HedgeNet research prototype. Illustrative preview with fictional markets; live intake drafts only. No trades.',
  icons: { icon: "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Crect width='32' height='32' rx='8' fill='%232f5cf5'/%3E%3Cpath d='M6 23L13 9L20 23L27 9' fill='none' stroke='white' stroke-width='3'/%3E%3C/svg%3E" },
};
export const viewport: Viewport = { width: 'device-width', initialScale: 1 };

export default function RootLayout({ children }: { children: ReactNode }) {
  return <html lang="en"><body>{children}</body></html>;
}
