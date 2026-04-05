/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,

  // Variables d'env exposées au browser
  env: {
    NEXT_PUBLIC_API_URL: process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:8000/api/v1',
    NEXT_PUBLIC_WS_URL:  process.env.NEXT_PUBLIC_WS_URL  ?? 'ws://localhost:8000/ws',
  },

  // Évite les erreurs d'import ESM avec lightweight-charts
  transpilePackages: ['lightweight-charts'],

  // Headers permissifs pour dev Codespace
  async headers() {
    return [
      {
        source: '/(.*)',
        headers: [
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'X-Frame-Options',        value: 'DENY'    },
        ],
      },
    ];
  },
};

module.exports = nextConfig;