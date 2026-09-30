// Re-encode the raw screen-recording MP4s into small, web-friendly loops.
//
// Source files live in SOURCE_DIR, or a collection's `source:` folder (not
// committed - they're hundreds of MB, and student files carry names).
// Output goes straight into dist/videos/ which IS committed and deployed.
//
// Run: npm run encode                            (every collection)
//      npm run encode -- "Animated Album Covers"  (just that one)

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
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

// Autoplay collections (Apple Music) loop muted, so audio is dropped, the
// frame rate normalised and the frame halved. Click-to-play collections
// (student work) are already small, and keep their size, sound and frame
// rate, since those are part of the piece.
function scaleFilter(clickToPlay) {
  const width = clickToPlay ? 'trunc(iw/2)*2' : TARGET_WIDTH;
  return `scale=${width}:-2:flags=lanczos`;
}

function encode(sourcePath, outPath, clickToPlay) {
  run([
    '-y',
    '-i', sourcePath,
    '-map_metadata', '-1',                    // drop tags (may name the author)
    ...(clickToPlay
      // The cap stops grainy or noisy footage ballooning past its source size
      ? ['-map', '0:v:0', '-map', '0:a?', '-c:a', 'aac', '-b:a', '128k',
         '-maxrate', '3M', '-bufsize', '6M']
      : ['-an', '-r', String(FPS)]),
    '-c:v', 'libx264',
    '-profile:v', 'high',
    '-preset', 'slow',
    '-crf', String(CRF),
    '-vf', scaleFilter(clickToPlay),
    '-pix_fmt', 'yuv420p',                    // required for Safari/iOS
    '-movflags', '+faststart',                // lets playback start before full download
    outPath,
  ]);
}

// Copy the streams untouched, minus metadata - for when re-encoding a clip
// only makes it bigger.
function remux(sourcePath, outPath) {
  run([
    '-y',
    '-i', sourcePath,
    '-map_metadata', '-1',
    '-map', '0:v:0', '-map', '0:a?',
    '-c', 'copy',
    '-movflags', '+faststart',
    outPath,
  ]);
}

function duration(sourcePath) {
  const out = execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration',
    '-of', 'csv=p=0', sourcePath]).toString();
  return parseFloat(out) || 2;
}

// Click-to-play clips sit on their poster until played, so take it from the
// middle of the clip rather than 1s in, which is often a fade from black.
function poster(sourcePath, outPath, clickToPlay) {
  const at = clickToPlay ? duration(sourcePath) / 2 : 1;
  run([
    '-y',
    '-ss', at.toFixed(2),
    '-i', sourcePath,
    '-frames:v', '1',
    '-vf', scaleFilter(clickToPlay),
    '-q:v', '4',
    outPath,
  ]);
}

// Source -> output filename pairs for a collection. Numbered collections take
// every .mp4 in their source folder; the order comes from a hash of the
// filename, so it's stable between runs but, unlike sorting, doesn't follow
// the surnames the filenames start with.
function jobsFor(collection) {
  if (!collection.numbered) {
    const dir = collection.source || SOURCE_DIR;
    return collection.videos.map(video => ({
      source: path.join(dir, video.file),
      out: video.file,
      label: video.file,
    }));
  }

  if (!fs.existsSync(collection.source)) {
    console.log(`  ✗ Missing source folder: ${collection.source}`);
    return [];
  }
  const hash = name => crypto.createHash('sha1').update(name).digest('hex');
  const files = fs.readdirSync(collection.source)
    .filter(file => file.toLowerCase().endsWith('.mp4'))
    .sort((a, b) => hash(a).localeCompare(hash(b)));

  const digits = Math.max(2, String(files.length).length);
  return files.map((file, i) => {
    const out = `${collection.slug}-${String(i + 1).padStart(digits, '0')}.mp4`;
    // Log only the output name - the source name identifies the student
    return { source: path.join(collection.source, file), out, label: out };
  });
}

// Numbered clips left over from a previous encode with more source files
function removeStaleOutputs(collection, jobs) {
  const keep = new Set(jobs.map(job => job.out));
  const pattern = new RegExp(`^${collection.slug}-\\d+\\.mp4$`);
  for (const file of fs.readdirSync(OUT_DIR)) {
    if (pattern.test(file) && !keep.has(file)) {
      fs.unlinkSync(path.join(OUT_DIR, file));
      fs.rmSync(path.join(POSTER_DIR, file.replace(/\.mp4$/, '.jpg')), { force: true });
      console.log(`  Removed stale ${file}`);
    }
  }
}

function mb(file) {
  return (fs.statSync(file).size / 1024 / 1024).toFixed(1);
}

function main() {
  // Optional collection names/slugs to encode; everything if none given
  const only = process.argv.slice(2).map(arg => arg.toLowerCase());
  const collections = parseVideosFile('videos.md').filter(collection =>
    !only.length || only.includes(collection.name.toLowerCase()) || only.includes(collection.slug));

  fs.mkdirSync(POSTER_DIR, { recursive: true });

  let sourceTotal = 0;
  let outTotal = 0;

  for (const collection of collections) {
    console.log(`Encoding collection: ${collection.name}\n`);
    const clickToPlay = collection.playback === 'click';
    const jobs = jobsFor(collection);

    for (const job of jobs) {
      if (!fs.existsSync(job.source)) {
        console.log(`  ✗ Missing source: ${job.label}`);
        continue;
      }

      const outPath = path.join(OUT_DIR, job.out);
      const posterPath = path.join(POSTER_DIR, job.out.replace(/\.mp4$/, '.jpg'));

      process.stdout.write(`  ${job.label} ... `);
      encode(job.source, outPath, clickToPlay);
      if (clickToPlay && fs.statSync(outPath).size > fs.statSync(job.source).size) {
        process.stdout.write('(re-encode was larger, copying original) ');
        remux(job.source, outPath);
      }
      poster(job.source, posterPath, clickToPlay);

      sourceTotal += fs.statSync(job.source).size;
      outTotal += fs.statSync(outPath).size;
      console.log(`${mb(job.source)}MB -> ${mb(outPath)}MB`);
    }

    if (collection.numbered && jobs.length) removeStaleOutputs(collection, jobs);
    console.log('');
  }

  const toMb = bytes => (bytes / 1024 / 1024).toFixed(1);
  console.log(`Total: ${toMb(sourceTotal)}MB -> ${toMb(outTotal)}MB`);
  console.log(`\nEncode complete. Now run: npm run build`);
}

main();
