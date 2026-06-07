/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // The web UI reads the seed filesystem + .compost/events.sqlite for fast reads;
  // every mutation dispatches the CLI engine in-process (#119). The engine and
  // its retrieval sibling depend on better-sqlite3 / @lancedb/lancedb — native
  // modules that must NOT be bundled or run on the edge runtime. Mark them
  // external so Next requires them at runtime under Node, and pin every API
  // route to `export const runtime = 'nodejs'`.
  serverExternalPackages: [
    'better-sqlite3',
    '@lancedb/lancedb',
    '@they-juanreina/compost-cli',
    '@they-juanreina/compost-provenance',
    '@they-juanreina/compost-retrieval',
  ],
  // The codebase uses NodeNext-style explicit `.js` import specifiers that point
  // at `.ts` sources (so the same files resolve under tsc/tsx and Next). Teach
  // webpack to try the TS extensions for a `.js` request.
  webpack: (config) => {
    config.resolve.extensionAlias = {
      ...config.resolve.extensionAlias,
      '.js': ['.ts', '.tsx', '.js'],
      '.jsx': ['.tsx', '.jsx'],
    }
    return config
  },
}

export default nextConfig
