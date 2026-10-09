import type { NextConfig } from "next";

const config: NextConfig = {
  reactStrictMode: true,
  // The workspace packages ship TypeScript source, not build output.
  transpilePackages: ["@cac/core", "@cac/db"],
  // pdfkit reads its built-in font metrics (.afm) from disk at runtime, relative
  // to its own package directory. Bundled, that path points inside .next and the
  // files are not there, so every PDF fails with ENOENT on Helvetica.afm.
  serverExternalPackages: ["@electric-sql/pglite", "@node-rs/argon2", "pg", "pdfkit"],
  poweredByHeader: false,
  experimental: {
    // Enable client-side App Router cache for instant 0ms back/forward and tab navigation during demos
    staleTimes: {
      dynamic: 300,
      static: 1800,
    },
    // A document upload goes through a server action, and the default limit on an
    // action's body is 1 MB — so without this every scanned certificate over that size
    // fails with an error that says nothing about size. Matched to MAX_UPLOAD_BYTES in
    // @cac/core, which is where the limit is actually enforced and explained.
    serverActions: { bodySizeLimit: "26mb" },
  },
  webpack(config, { isServer }) {
    if (isServer) {
      // These carry native .node binaries or WASM. transpilePackages makes
      // webpack follow @cac/core's imports, which drags them in; serverExternal
      // Packages alone does not cover a transitive reach like that. Leaving
      // them external means Node require()s them at runtime, as intended.
      config.externals = [
        ...(Array.isArray(config.externals) ? config.externals : [config.externals].filter(Boolean)),
        "@node-rs/argon2",
        "@electric-sql/pglite",
        "pg",
        "pdfkit",
      ];
    }
    // The workspace packages are valid Node ESM, so their relative imports
    // carry .js extensions while the files on disk are .ts. Node and tsx
    // resolve that; webpack does not without being told.
    config.resolve.extensionAlias = {
      ".js": [".ts", ".tsx", ".js"],
      ".mjs": [".mts", ".mjs"],
    };
    return config;
  },
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          {
            key: "Permissions-Policy",
            value: "camera=(), microphone=(), geolocation=(), payment=()",
          },
        ],
      },
    ];
  },
};

export default config;
