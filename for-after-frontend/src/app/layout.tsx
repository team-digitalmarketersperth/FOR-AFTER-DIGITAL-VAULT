import type { Metadata, Viewport } from 'next';
import { Cormorant, Figtree } from 'next/font/google';
import { Providers } from '@/components/providers';
import './globals.css';

// The WordPress site's own fonts (Figtree body, Cormorant display), both
// open-licence Google Fonts, self-hosted by next/font at build time.
const body = Figtree({ variable: '--font-body', subsets: ['latin'] });
const display = Cormorant({
  variable: '--font-display',
  subsets: ['latin'],
  weight: ['400', '500', '600'],
  style: ['normal', 'italic'],
});

export const metadata: Metadata = {
  title: { default: 'For After', template: '%s · For After' },
  description:
    'A private, secure place to preserve messages, memories and wishes for the people you love.',
  // The app is private; the public site is WordPress (forafter.com.au).
  robots: { index: false, follow: false },
};

export const viewport: Viewport = {
  themeColor: '#fafbfc',
};

export default function RootLayout({ children }: LayoutProps<'/'>) {
  return (
    <html lang="en-AU" className={`${body.variable} ${display.variable}`}>
      <body className="min-h-dvh">
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
