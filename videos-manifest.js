// Shared parser for videos.md, used by both encode-videos.js and build.js.
//
// Format - a heading, then blank-line-separated blocks of three lines:
//
//   # Collection Name
//
//   filename.mp4
//   Title — Artist
//   https://link-to-open-when-clicked

const fs = require('fs');

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
      currentCollection = { name, slug: slugify(name), type: 'video', videos: [] };
    } else if (trimmed === '') {
      flushBlock();
    } else {
      block.push(trimmed);
    }
  }

  flushBlock();
  if (currentCollection) collections.push(currentCollection);

  return collections;
}

module.exports = { parseVideosFile, slugify };
