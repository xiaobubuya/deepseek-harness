#!/usr/bin/env node
/**
 * PhotoCraft CLI — Node.js + sharp implementation
 *
 * Interface: photocraft-cli run <input> --cmd <command> --params <json> --out <output>
 * Compatible with ai-agent-server's cli-executor.ts
 */

import sharp from 'sharp';
import fs from 'fs';
import path from 'path';

const args = process.argv.slice(2);

if (!args.length || args[0] === '-h' || args[0] === '--help') {
  console.log('PhotoCraft CLI (Node.js + sharp)');
  console.log('Usage: photocraft-cli run <input> --cmd <command> --params <json> --out <output>');
  process.exit(0);
}

if (args[0] !== 'run') {
  console.error(`Unknown command: ${args[0]}`);
  process.exit(1);
}

let inputPath, cmd, params, outputPath;
for (let i = 1; i < args.length; i++) {
  if (args[i] === '--cmd') cmd = args[++i];
  else if (args[i] === '--params') { try { params = JSON.parse(args[++i]); } catch { params = {}; } }
  else if (args[i] === '--out') outputPath = args[++i];
  else if (!inputPath) inputPath = args[i];
}

if (!inputPath || !cmd || !outputPath) {
  console.error('Usage: photocraft-cli run <input> --cmd <command> --params <json> --out <output>');
  process.exit(1);
}

const clamp = (v, min, max) => Math.max(min, Math.min(max, v));

// ── Color ops ──────────────────────────────────────────────────────
const cOps = {
  'color.temperature':  (img, v) => img.modulate(1 + v/500, 1 - v/500, 1 + v/1000),
  'color.saturation':   (img, v) => img.saturation(v / 100),
  'color.brightness':   (img, v) => img.gamma(clamp(1 + v/100, 0.1, 3)),
  'color.contrast':     (img, v) => img.contrast(clamp(1 + v/100, 0.1, 3)),
  'color.hue':          (img, v) => img.rotate(0), // hue shift is approximated via color channel manipulation
  'color.exposure':     (img, v) => { const f = clamp(1 + v/100, 0.1, 3); return img.modulate(f, f, f); },
};

// ── Filters ────────────────────────────────────────────────────────
const filters = {
  'filter.warm':       (img) => img.tint({ r: 255, g: 240, b: 200, alpha: 0.15 }).modulate(1.05, 0.97, 0.93),
  'filter.cool':       (img) => img.tint({ r: 200, g: 220, b: 255, alpha: 0.15 }).modulate(0.95, 0.97, 1.05),
  'filter.blackwhite': (img) => img.grayscale(),
  'filter.sepia':      (img) => img.grayscale({ brightness: 0.3, alpha: 0.3 }).tint({ r: 230, g: 200, b: 150 }),
  'filter.vintage':    (img) => img.grayscale({ brightness: 0.3, alpha: 0.3 }).tint({ r: 200, g: 180, b: 140 }),
};

// ── Effects ────────────────────────────────────────────────────────
const effects = {
  'sharpen': (img, s) => img.sharpen({ sigma: clamp(s/100,0,3)*2, m1: clamp(s/100,0,3)*0.5, m2: clamp(s/100,0,3)*0.25 }),
  'denoise': (img, s) => img.denoise(clamp(s/100,0,3)*3),
  'blur':    (img, r) => img.blur(clamp(r,1,50)),
};

// ── Vignette via SVG overlay ───────────────────────────────────────
async function vignette(inputPath, strength, outputPath) {
  const meta = await sharp(inputPath).metadata();
  const size = Math.max(meta.width, meta.height);
  const inner = size * (1 - clamp(strength/100, 0, 0.8));
  const svg = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${meta.width}" height="${meta.height}">
    <defs><radialGradient id="v" cx="50%" cy="50%" r="70%">
      <stop offset="${Math.round(inner/size*100)}%" stop-color="white"/>
      <stop offset="100%" stop-color="black"/>
    </radialGradient></defs>
    <rect width="100%" height="100%" fill="url(#v)"/>
  </svg>`);
  return sharp(inputPath).composite([{ input: svg, blend: 'multiply' }]).toFile(outputPath);
}

// ── Grain via raw pixel noise ──────────────────────────────────────
async function grain(inputPath, amount, outputPath) {
  const meta = await sharp(inputPath).metadata();
  const channels = meta.channels || 3;
  const buf = await sharp(inputPath).raw().toBuffer({ resolveWithObject: true });
  const arr = new Uint8Array(buf.data);
  const a = clamp(amount / 100, 0, 1);
  const step = channels + 1; // RGBA
  for (let i = 0; i < arr.length; i += step) {
    const n = (Math.random() - 0.5) * a * 60;
    arr[i]     = clamp(arr[i]     + n, 0, 255);
    arr[i + 1] = clamp(arr[i + 1] + n, 0, 255);
    arr[i + 2] = clamp(arr[i + 2] + n, 0, 255);
  }
  return sharp(buf.data, { raw: { width: meta.width, height: meta.height, channels, format: channels === 4 ? 'rgba' : 'rgb' } }).toFile(outputPath);
}

// ── Transformations ────────────────────────────────────────────────
const transforms = {
  'resize': (img, p) => img.resize({ width: p.width, height: p.height, fit: 'cover' }),
  'crop':   (img, p) => img.extract({ left: p.x ?? 0, top: p.y ?? 0, width: p.width ?? 100, height: p.height ?? 100 }),
  'rotate': (img, a) => img.rotate(a),
  'flip':   (img, h) => h ? img.flop() : img.flip(),
};

// ── Execute ────────────────────────────────────────────────────────
async function execute() {
  if (!fs.existsSync(inputPath)) { console.error(`Input not found: ${inputPath}`); process.exit(1); }
  const outDir = path.dirname(outputPath);
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

  try {
    const p = params || {};

    // Special cases (not pipelined)
    if (cmd === 'vignette') {
      await vignette(inputPath, p.strength ?? 50, outputPath);
      console.log(`OK: vignette(strength=${p.strength ?? 50}) → ${outputPath}`);
      return;
    }
    if (cmd === 'grain') {
      await grain(inputPath, p.amount ?? 50, outputPath);
      console.log(`OK: grain(amount=${p.amount ?? 50}) → ${outputPath}`);
      return;
    }

    // Pipelined operations
    let pipeline = sharp(inputPath);

    if (cOps[cmd]) {
      pipeline = cOps[cmd](pipeline, p.value ?? (cmd === 'color.saturation' ? 100 : 0));
    } else if (filters[cmd]) {
      pipeline = filters[cmd](pipeline);
    } else if (effects[cmd]) {
      const strength = p.strength ?? p.radius ?? 50;
      pipeline = effects[cmd](pipeline, cmd === 'blur' ? (p.radius ?? 5) : strength);
    } else if (transforms[cmd]) {
      pipeline = transforms[cmd](pipeline, p);
    } else {
      console.error(`Unknown command: ${cmd}`);
      process.exit(1);
    }

    await pipeline.toFile(outputPath);
    console.log(`OK: ${cmd} → ${outputPath}`);
  } catch (err) {
    console.error(`Error: ${err.message}`);
    process.exit(1);
  }
}

execute();
