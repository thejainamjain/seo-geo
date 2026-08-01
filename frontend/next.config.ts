import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  images: {
    // Hero images only ever come from two places: a user upload (proxied
    // through Cloudinary by blogService.uploadImage) or the Unsplash fetch
    // pipeline (lib/unsplash.ts). next/image refuses any host not listed
    // here, so both need to be explicit.
    remotePatterns: [
      { protocol: 'https', hostname: 'res.cloudinary.com' },
      { protocol: 'https', hostname: 'images.unsplash.com' },
    ],
  },
};

export default nextConfig;
