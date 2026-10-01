import type { NextConfig } from 'next';

// Conservative headers only. A Content-Security-Policy is deferred until the
// staging domains are known (it must allow api.forafter.com.au and B2 media);
// an untested CSP would silently break API calls. The API has its own Helmet.
const nextConfig: NextConfig = {
  poweredByHeader: false,
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
        ],
      },
    ];
  },
};

export default nextConfig;
