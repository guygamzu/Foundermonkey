/** @type {import('next').NextConfig} */
const API_URL = process.env.NEXT_PUBLIC_API_URL || (process.env.NODE_ENV === 'production' ? 'https://api.lapen.ai' : 'http://localhost:3001');

const nextConfig = {
  reactStrictMode: true,
  env: {
    NEXT_PUBLIC_API_URL: API_URL,
  },
  async rewrites() {
    return [
      {
        source: '/api/document-proxy/:token',
        destination: `${API_URL}/api/signing/session/:token/document`,
      },
      {
        source: '/api/preview-proxy/:id',
        destination: `${API_URL}/api/documents/preview/:id/document`,
      },
      {
        source: '/api/setup-proxy/:id',
        destination: `${API_URL}/api/setup/:id/document`,
      },
    ];
  },
};

export default nextConfig;
