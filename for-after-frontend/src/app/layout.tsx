import type { Metadata, Viewport } from 'next';
import localFont from 'next/font/local';
import { Providers } from '@/components/providers';
import './globals.css';

// The WordPress site's own fonts (Figtree body, Cormorant display), both SIL
// Open Font License Google Fonts. Vendored in ./fonts (latin subset, variable
// weight, from fonts.gstatic.com) so dev and builds never depend on reaching
// Google: offline or slow networks used to fall back to system fonts.
const body = localFont({
  src: './fonts/figtree-latin.woff2',
  variable: '--font-body',
  weight: '300 900',
  display: 'swap',
});
const display = localFont({
  src: [
    { path: './fonts/cormorant-latin.woff2', weight: '400 600', style: 'normal' },
    { path: './fonts/cormorant-italic-latin.woff2', weight: '400 600', style: 'italic' },
  ],
  variable: '--font-display',
  display: 'swap',
  adjustFontFallback: 'Times New Roman',
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
