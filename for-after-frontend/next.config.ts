import type { NextConfig } from 'next';

// Conservative headers only. A Content-Security-Policy is deferred until the
// staging domains are known (it must allow api.forafter.com.au and B2 media);
// an untested CSP would silently break API calls. The API has its own Helmet.
const nextConfig: NextConfig = {
  poweredByHeader: false,
  // Staging on two *.up.railway.app hosts: that suffix is a public suffix, so
  // the API's SameSite=Lax cookies would be cross-site. API_PROXY_TARGET (the
  // API origin, read at build time) serves /api/v1 from this origin instead;
  // pair it with NEXT_PUBLIC_API_BASE_URL=/api/v1. Unset: no proxy.
  async rewrites() {
    const target = process.env.API_PROXY_TARGET?.replace(/\/+$/, '');
    return target
      ? [{ source: '/api/v1/:path*', destination: `${target}/api/v1/:path*` }]
      : [];
  },
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
