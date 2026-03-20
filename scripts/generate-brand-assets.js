#!/usr/bin/env node
/**
 * Brand Asset Generator
 * Converts SVG logos to PNG at all required sizes with transparent backgrounds.
 * Usage: node scripts/generate-brand-assets.js
 */

const sharp = require('sharp');
const fs = require('fs');
const path = require('path');

const BRAND_DIR = path.join(__dirname, '..', 'public', 'icons', 'brand');

// Logo variants and their output configs
const VARIANTS = [
  {
    svg: 'logo-primary.svg',
    outputs: [
      { name: 'logo-primary', sizes: [1024, 512, 256] },
    ]
  },
  {
    svg: 'logo-light.svg',
    outputs: [
      { name: 'logo-light', sizes: [1024, 512, 256] },
    ]
  },
  {
    svg: 'logo-dark.svg',
    outputs: [
      { name: 'logo-dark', sizes: [1024, 512, 256] },
    ]
  },
  {
    svg: 'logo-white.svg',
    outputs: [
      { name: 'logo-white', sizes: [1024, 512, 256] },
    ]
  },
  {
    svg: 'logo-black.svg',
    outputs: [
      { name: 'logo-black', sizes: [1024, 512, 256] },
    ]
  },
  {
    svg: 'icon-app.svg',
    outputs: [
      { name: 'icon-app', sizes: [1024, 512, 256, 180, 120, 64, 32, 16] },
    ]
  },
];

// Favicon sizes use the app icon (simplified) SVG
const FAVICON_VARIANT = {
  svg: 'icon-app.svg',
  outputs: [
    { name: 'favicon', sizes: [32, 16] },
  ]
};

async function generatePNG(svgPath, outputName, size) {
  const svgBuffer = fs.readFileSync(svgPath);
  const outputPath = path.join(BRAND_DIR, `${outputName}-${size}.png`);

  await sharp(svgBuffer, { density: Math.max(150, Math.round(150 * (size / 256))) })
    .resize(size, size, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png({ compressionLevel: 9, adaptiveFiltering: true })
    .toFile(outputPath);

  const stats = fs.statSync(outputPath);
  console.log(`  ✓ ${outputName}-${size}.png (${(stats.size / 1024).toFixed(1)}KB)`);
}

async function main() {
  console.log('Brand Asset Generator');
  console.log('=====================\n');

  const allVariants = [...VARIANTS, FAVICON_VARIANT];

  for (const variant of allVariants) {
    const svgPath = path.join(BRAND_DIR, variant.svg);

    if (!fs.existsSync(svgPath)) {
      console.error(`⚠ Missing SVG: ${variant.svg}`);
      continue;
    }

    for (const output of variant.outputs) {
      console.log(`\n${output.name}:`);
      for (const size of output.sizes) {
        try {
          await generatePNG(svgPath, output.name, size);
        } catch (err) {
          console.error(`  ✗ ${output.name}-${size}.png: ${err.message}`);
        }
      }
    }
  }

  // Summary
  console.log('\n=====================');
  const pngFiles = fs.readdirSync(BRAND_DIR).filter(f => f.endsWith('.png'));
  const svgFiles = fs.readdirSync(BRAND_DIR).filter(f => f.endsWith('.svg'));
  console.log(`Generated ${pngFiles.length} PNGs + ${svgFiles.length} SVGs`);
  console.log(`Output: ${BRAND_DIR}/`);
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
