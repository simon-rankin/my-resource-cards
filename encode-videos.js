// Re-encode the raw screen-recording MP4s into small, web-friendly loops.
//
// Source files live in SOURCE_DIR (not committed - they're ~400MB).
// Output goes straight into dist/videos/ which IS committed and deployed.
//
// Run: npm run encode

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { parseVideosFile } = require('./videos-manifest');

const SOURCE_DIR = 'apple-music-samples-cut';
const OUT_DIR = path.join('dist', 'videos');
const POSTER_DIR = path.join(OUT_DIR, 'posters');

// Roughly half the source resolution (1170x1710 -> 586x856). Still ~1.5x the
// size the grid renders at, so it stays sharp on retina without the 15Mbps
// source bloat. Must be even - x264 rejects odd dimensions.
const TARGET_WIDTH = 586;
const FPS = 25; // sources are 50fps, so this halves cleanly with no judder
const CRF = 26;

function run(args) {
  try {
    execFileSync('ffmpeg', args, { stdio: ['ignore', 'ignore', 'pipe'] });
  } catch (e) {
    // ffmpeg puts everything on stderr; surface the tail so failures are readable.
    const log = (e.stderr || '').toString().trim().split('\n').slice(-8).join('\n');
    throw new Error(`ffmpeg failed:\n${log}`);
  }
}

function encode(sourcePath, outPath) {
  run([
    '-y',
    '-i', sourcePath,
    '-an',                                    // drop audio - these autoplay muted
    '-c:v', 'libx264',
    '-profile:v', 'high',
    '-preset', 'slow',
    '-crf', String(CRF),
    '-r', String(FPS),
    '-vf', `scale=${TARGET_WIDTH}:-2:flags=lanczos`,
    '-pix_fmt', 'yuv420p',                    // required for Safari/iOS
    '-movflags', '+faststart',                // lets playback start before full download
    outPath,
  ]);
}

function poster(sourcePath, outPath) {
  run([
    '-y',
    '-ss', '1',
    '-i', sourcePath,
    '-frames:v', '1',
    '-vf', `scale=${TARGET_WIDTH}:-2:flags=lanczos`,
    '-q:v', '4',
    outPath,
  ]);
}

function mb(file) {
  return (fs.statSync(file).size / 1024 / 1024).toFixed(1);
}

function main() {
  const collections = parseVideosFile('videos.md');

  fs.mkdirSync(POSTER_DIR, { recursive: true });

  let sourceTotal = 0;
  let outTotal = 0;

  for (const collection of collections) {
    console.log(`Encoding collection: ${collection.name}\n`);

    for (const video of collection.videos) {
      const sourcePath = path.join(SOURCE_DIR, video.file);

      if (!fs.existsSync(sourcePath)) {
        console.log(`  ✗ Missing source: ${video.file}`);
        continue;
      }

      const outPath = path.join(OUT_DIR, video.file);
      const posterPath = path.join(POSTER_DIR, video.file.replace(/\.mp4$/, '.jpg'));

      process.stdout.write(`  ${video.file} ... `);
      encode(sourcePath, outPath);
      poster(sourcePath, posterPath);

      sourceTotal += fs.statSync(sourcePath).size;
      outTotal += fs.statSync(outPath).size;
      console.log(`${mb(sourcePath)}MB -> ${mb(outPath)}MB`);
    }
    console.log('');
  }

  const toMb = bytes => (bytes / 1024 / 1024).toFixed(1);
  console.log(`Total: ${toMb(sourceTotal)}MB -> ${toMb(outTotal)}MB`);
  console.log(`\nEncode complete. Now run: npm run build`);
}

main();
