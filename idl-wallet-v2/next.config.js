/** @type {import('next').NextConfig} */
// Real installed SDK version, read at build time so the UI can never show a stale literal.
// (The package is installed under its old name via a yarn alias; this reports the resolved version.)
//
// NOTE: read the file directly — do NOT `require('@hyperledger/.../package.json')`. SDK v8 ships
// an `exports` map that does not expose "./package.json", so require() throws
// ERR_PACKAGE_PATH_NOT_EXPORTED and silently falls back, which is how this first shipped as
// "unknown".
const SDK_VERSION = (() => {
    try {
        const pkgPath = require('path').join(
            __dirname, 'node_modules', '@hyperledger', 'identus-edge-agent-sdk', 'package.json');
        return JSON.parse(require('fs').readFileSync(pkgPath, 'utf8')).version;
    } catch { return 'unknown'; }
})();

const nextConfig = {
    env: {
        NEXT_PUBLIC_SDK_VERSION: SDK_VERSION,
        // Baked at build time and logged once on wallet init (see pages/_app.tsx). The wallet is a
        // long-running SPA: an open tab keeps executing the JS it loaded, so a rebuild+restart on
        // the server changes nothing until the tab is reloaded. Twice now a debug log has been
        // ambiguous between "the new code ran and bailed" and "the tab never loaded the new code";
        // this makes the running build identifiable from the log file alone.
        NEXT_PUBLIC_BUILD_STAMP: new Date().toISOString(),
    },

    // Base path for domain routing: https://identuslabel.cz/wallet-v2
    basePath: '/wallet-v2',

    // Asset prefix for correct resource loading
    assetPrefix: '/wallet-v2',

    // Disable Fast Refresh to prevent automatic page reloads
    reactStrictMode: false,

    // Skip ESLint during production builds (unescaped entities warnings)
    eslint: {
        ignoreDuringBuilds: true,
    },

    // Skip TypeScript errors during build (relative SDK paths not resolvable from standalone location)
    typescript: {
        ignoreBuildErrors: true,
    },

    experimental: {
        // SDK v8 is "type": "module" and its ESM build performs a dynamic require("crypto"),
        // which is illegal in an ESM context and crashes Next's server pass. Next 14 defaults
        // esmExternals to true, which imports externalized ESM packages through the ESM loader —
        // overriding the `commonjs` externals directive set in webpack() below. Forcing this off
        // makes the server require() the package, resolving its "require" condition to
        // build/index.cjs, where dynamic require works. Verified: `require(sdk)` loads cleanly
        // while `import(sdk)` throws exactly the build error.
        esmExternals: false,
    },

    webpack: (config, { isServer, dev }) => {
        // Disable file watching to prevent Fast Refresh
        if (dev && !isServer) {
            config.watchOptions = {
                ...config.watchOptions,
                // Ignore directories and config files
                ignored: [
                    '**/node_modules/**',
                    '**/.next/**',
                    '**/next.config.js',  // Ignore self to prevent restart loops
                    '**/package.json',
                    '**/yarn.lock',
                    '**/.git/**',
                ],
                // Use polling with very long interval to reduce phantom filesystem events
                poll: 3600000,  // Poll every 1 hour instead of using inotify events
                aggregateTimeout: 3600000,  // Wait 1 hour before triggering rebuild
            };
        }
        // SDK v8 is an ESM package ("type": "module") whose bundled build does a dynamic
        // require("crypto") — illegal in an ESM context. Next's server pass ("Collecting page
        // data") would load `build/index.js` (the "import" condition) and crash the build.
        //
        // Externalizing it on the server leaves `require('@hyperledger/...')` in the server output,
        // so Node resolves the package's "require" condition -> `build/index.cjs`, where dynamic
        // require works. This wallet is entirely client-side (IndexedDB, WebCrypto), so the server
        // never actually exercises the SDK — it only needs to not explode while prerendering.
        if (isServer) {
            const SDK_PKG = '@hyperledger/identus-edge-agent-sdk';
            config.externals = [
                ...(Array.isArray(config.externals) ? config.externals : [config.externals].filter(Boolean)),
                ({ request }, cb) =>
                    request === SDK_PKG || (request && request.startsWith(SDK_PKG + '/'))
                        ? cb(null, 'commonjs ' + request)
                        : cb(),
            ];
        }

        if (!isServer) {
            config.resolve.fallback = {
                fs: false,
                crypto: false,
                stream: false,
                path: false,
                buffer: require.resolve('buffer/'),  // Add Buffer polyfill for browser
            };

            // Provide Buffer global for browser
            config.plugins.push(
                new (require('webpack').ProvidePlugin)({
                    Buffer: ['buffer', 'Buffer'],
                })
            );
        }
        return config;
    },
}

module.exports = nextConfig
