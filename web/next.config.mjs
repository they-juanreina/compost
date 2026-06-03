/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // The web UI reads .compost/state.sqlite for fast reads; mutations dispatch
  // the CLI engine. Server actions / API routes wire that up.
  experimental: {},
}

export default nextConfig
