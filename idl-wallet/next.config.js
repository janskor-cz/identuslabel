/** @type {import('next').NextConfig} */
const nextConfig = {
    // Base path for domain routing: https://identuslabel.cz/wallet
    basePath: '/wallet',

    // Asset prefix for correct resource loading
    assetPrefix: '/wallet',

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
