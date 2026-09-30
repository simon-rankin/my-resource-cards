// Shared parser for videos.md, used by both encode-videos.js and build.js.
//
// Format - a heading, then blank-line-separated blocks of three lines:
//
//   # Collection Name
//
//   filename.mp4
//   Title — Artist
//   https://link-to-open-when-clicked
//
// Option lines may follow the heading:
//
//   playback: click   - play on click (with sound) instead of autoplaying muted
//   source: folder    - encode every .mp4 in this folder as anonymous numbered
//                       clips (<slug>-01.mp4, ...), with no blocks needed. For
//                       student work: source filenames carry names and IDs, so
//                       the folder is gitignored and only the numbers publish.

const fs = require('fs');
const path = require('path');

const OPTION_LINE = /^(playback|source):\s*(.+)$/i;

// Numbered clips already encoded for a collection. build.js reads these rather
// than the source folder, which isn't committed.
function numberedOutputs(slug) {
  const dir = path.join('dist', 'videos');
  if (!fs.existsSync(dir)) return [];
  const pattern = new RegExp(`^${slug}-\\d+\\.mp4$`);
  return fs.readdirSync(dir).filter(file => pattern.test(file)).sort();
}

function slugify(text) {
  return text
    .toLowerCase()
    .replace(/[^\w\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .trim();
}

function parseVideosFile(filePath) {
  if (!fs.existsSync(filePath)) {
    return [];
  }

  const lines = fs.readFileSync(filePath, 'utf-8').split('\n');

  const collections = [];
  let currentCollection = null;
  let block = [];

  // A block is complete once we hit a blank line or a new heading.
  function flushBlock() {
    if (!currentCollection || block.length === 0) {
      block = [];
      return;
    }

    const [file, titleLine, url] = block;
    if (!file || !file.endsWith('.mp4')) {
      console.warn(`  ! Skipping block in ${filePath}, expected an .mp4 filename: ${block[0]}`);
      block = [];
      return;
    }

    // "Title — Artist" splits into two display lines; a bare title is fine too.
    const [title, artist = ''] = (titleLine || file).split(/\s+—\s+/);

    currentCollection.videos.push({
      file,
      title: title.trim(),
      artist: artist.trim(),
      url: (url || '').trim(),
    });

    block = [];
  }

  for (const line of lines) {
    const trimmed = line.trim();

    if (trimmed.startsWith('# ')) {
      flushBlock();
      if (currentCollection) collections.push(currentCollection);

      const name = trimmed.substring(2).trim();
      currentCollection = { name, slug: slugify(name), type: 'video', playback: 'autoplay', videos: [] };
    } else if (currentCollection && block.length === 0 && OPTION_LINE.test(trimmed)) {
      const [, key, value] = trimmed.match(OPTION_LINE);
      currentCollection[key.toLowerCase()] = value.trim();
    } else if (trimmed === '') {
      flushBlock();
    } else {
      block.push(trimmed);
    }
  }

  flushBlock();
  if (currentCollection) collections.push(currentCollection);

  for (const collection of collections) {
    if (collection.source && collection.videos.length === 0) {
      collection.numbered = true;
      collection.videos = numberedOutputs(collection.slug)
        .map(file => ({ file, title: '', artist: '', url: '' }));
    }
  }

  return collections;
}

module.exports = { parseVideosFile, slugify };
