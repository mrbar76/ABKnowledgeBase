#!/usr/bin/env node
// Generate PNG icons from SVG for PWA manifest
// Run: node scripts/generate-icons.js

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const svgPath = path.join(__dirname, '..', 'public', 'icons', 'icon.svg');
const sizes = [192, 512];

async function generate() {
  let sharp;
  try {
    sharp = require('sharp');
  } catch {
    console.log('sharp not installed, skipping PNG icon generation');
    console.log('Install with: npm install sharp');
    return;
  }

  const svgBuffer = fs.readFileSync(svgPath);

  for (const size of sizes) {
    const outPath = path.join(__dirname, '..', 'public', 'icons', `icon-${size}.png`);
    await sharp(svgBuffer)
      .resize(size, size)
      .png()
      .toFile(outPath);
    console.log(`Generated ${outPath}`);
  }
}

generate().catch(err => {
  console.error('Icon generation failed:', err.message);
  process.exit(0); // Non-fatal
});
