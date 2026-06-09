// The web app dispatches the CLI engine in-process (#119). The engine and its
// retrieval sibling depend on better-sqlite3 / @lancedb/lancedb — native modules
// (.node) that must never be bundled or run on the edge runtime. They reach the
// bundler transitively through the pnpm-symlinked `@they-juanreina/compost-*`
// workspace packages, which `serverExternalPackages` doesn't reliably externalize
// (its node_modules heuristic misses symlinked workspace pkgs). So we externalize
// the engine packages + their native deps explicitly for the server build: webpack
// emits `require(...)` and Node loads them natively at runtime. Every API route
// also pins `export const runtime = 'nodejs'`.
const RUNTIME_EXTERNALS = [
  'better-sqlite3',
  '@lancedb/lancedb',
  '@they-juanreina/compost-cli',
  '@they-juanreina/compost-provenance',
  '@they-juanreina/compost-retrieval',
]

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  serverExternalPackages: RUNTIME_EXTERNALS,
  webpack: (config, { isServer }) => {
    // The codebase uses NodeNext-style explicit `.js` import specifiers that point
    // at `.ts` sources (so the same files resolve under tsc/tsx and Next). Teach
    // webpack to try the TS extensions for a `.js` request.
    config.resolve.extensionAlias = {
      ...config.resolve.extensionAlias,
      '.js': ['.ts', '.tsx', '.js'],
      '.jsx': ['.tsx', '.jsx'],
    }
    if (isServer) {
      const prior = config.externals ?? []
      config.externals = [
        ...(Array.isArray(prior) ? prior : [prior]),
        ({ request }, callback) => {
          if (
            request &&
            RUNTIME_EXTERNALS.some((p) => request === p || request.startsWith(`${p}/`))
          ) {
            return callback(null, `commonjs ${request}`)
          }
          return callback()
        },
      ]
    }
    return config
  },
}

export default nextConfig
