const fs = require('fs');
const path = require('path');
const fetch = require('node-fetch');
const puppeteer = require('puppeteer-core');
const cheerio = require('cheerio');
const { parseVideosFile } = require('./videos-manifest');

const BROWSER_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

// Some sites (Behance) return 403 to a generic browser user agent but serve
// full Open Graph tags to link-preview crawlers - which is exactly what this
// script is. Used as a retry when the normal request is refused.
const PREVIEW_USER_AGENT = 'facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)';

// Hosts whose images are worth pulling down at build time rather than
// hotlinking - either they expire, or they block off-site embedding.
const CACHE_IMAGES_FROM = ['behance.net'];

// Platforms where a missing preview means the post is gone or the host is
// blocking us - a screenshot would only capture an error or login page.
const NO_SCREENSHOT_HOSTS = ['youtube.com', 'youtu.be', 'vimeo.com', 'instagram.com', 'behance.net'];

// Headless Chrome, used to screenshot sites that have no usable preview image.
// Override with CHROME_PATH; if it isn't there, those links get a placeholder.
const CHROME_PATH = process.env.CHROME_PATH ||
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

// Inline SVG stand-in for links with no usable image. Self-contained, so it
// can't rot the way the old via.placeholder.com URLs did.
function placeholderImage(label) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="400" height="200">
    <rect width="400" height="200" fill="#f0f0f0"/>
    <text x="200" y="105" font-family="Helvetica, Arial, sans-serif" font-size="16"
          fill="#999" text-anchor="middle">${label.replace(/[<>&]/g, '')}</text>
  </svg>`;
  return `data:image/svg+xml,${encodeURIComponent(svg.replace(/\s+/g, ' '))}`;
}

// Read and parse the links.md file
function parseLinksFile(filePath) {
  const content = fs.readFileSync(filePath, 'utf-8');
  const lines = content.split('\n');
  
  const collections = [];
  let currentCollection = null;
  
  for (const line of lines) {
    const trimmed = line.trim();
    
    // Check if it's a heading (collection name)
    if (trimmed.startsWith('# ')) {
      if (currentCollection) {
        collections.push(currentCollection);
      }
      const name = trimmed.substring(2).trim();
      currentCollection = {
        name: name,
        slug: slugify(name),
        links: []
      };
    } 
    // Check if it's a URL
    else if (trimmed.startsWith('http://') || trimmed.startsWith('https://')) {
      if (currentCollection) {
        currentCollection.links.push(trimmed);
      }
    }
  }
  
  // Add the last collection
  if (currentCollection) {
    collections.push(currentCollection);
  }
  
  return collections;
}

// Convert text to URL-friendly slug
function slugify(text) {
  return text
    .toLowerCase()
    .replace(/[^\w\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .trim();
}

// Site-builder boilerplate that says nothing about the actual site. Portfolio
// hosts put these in the meta description when the owner hasn't set one.
const BOILERPLATE_PHRASES = [
  'built with readymag',
  'made with framer',
  'now included free with any creative cloud',
  'a template for independent creators',
  'you should absolutely hire this person',
  'powered by squarespace',
  'create a free website',
  'website builder',
];

// Check if description is generic/unhelpful
function isGenericDescription(description, url) {
  if (!description) return true;

  const genericPhrases = [
    'enjoy the videos and music you love',
    'share it all with friends',
    'youtube',
    'upload original content',
    'share videos with friends, family, and the world',
  ];

  const lowerDesc = description.toLowerCase();

  // Check if it contains generic YouTube text
  if (url.includes('youtube.com') && genericPhrases.some(phrase => lowerDesc.includes(phrase))) {
    return true;
  }

  // Platform boilerplate, whatever the host
  if (BOILERPLATE_PHRASES.some(phrase => lowerDesc.includes(phrase))) {
    return true;
  }

  // A bare domain name (e.g. "cargo.site") is a label, not a description
  if (/^[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(description.trim())) {
    return true;
  }

  // Check if description is too short to be useful
  if (description.length < 10) {
    return true;
  }
  
  return false;
}

// Find the first suitable image from page content
function findFirstImage($, url) {
  const images = $('img');
  const urlObj = new URL(url);
  
  for (let i = 0; i < images.length; i++) {
    const img = $(images[i]);
    let src = img.attr('src') || img.attr('data-src');
    
    if (!src) continue;
    
    // Skip tiny images, icons, logos (likely not content images)
    const width = parseInt(img.attr('width')) || 0;
    const height = parseInt(img.attr('height')) || 0;
    
    if (width > 0 && height > 0 && (width < 100 || height < 100)) {
      continue;
    }
    
    // Skip common icon/logo patterns
    if (src.includes('icon') || src.includes('logo') || src.includes('avatar')) {
      continue;
    }
    
    // Make URL absolute
    if (src.startsWith('//')) {
      src = 'https:' + src;
    } else if (src.startsWith('/')) {
      src = urlObj.origin + src;
    } else if (!src.startsWith('http')) {
      src = urlObj.origin + '/' + src;
    }
    
    // Force HTTPS
    if (src.startsWith('http://')) {
      src = src.replace('http://', 'https://');
    }
    
    return src;
  }
  
  return null;
}

// Behance's og:image points at the full-size render - a 1400px asset that can
// run to 22MB for an animated GIF. The "disp" variant is the same image at
// 600px, which is still ~1.6x the size a card renders at. Not every asset path
// has one, so callers fall back to the original.
function smallerBehanceVariant(imageUrl) {
  if (!imageUrl.includes('behance.net')) return null;
  const smaller = imageUrl.replace(/\/(project_modules|projects)\/[^/]+\//, '/$1/disp/');
  return smaller === imageUrl ? null : smaller;
}

// Download and save image locally
async function downloadImage(imageUrl, filename) {
  try {
    const response = await fetch(imageUrl);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);

    const buffer = await response.buffer();
    if (buffer.length === 0) throw new Error('empty response');

    // Ensure images directory exists
    const imagesDir = path.join('dist', 'images');
    if (!fs.existsSync(imagesDir)) {
      fs.mkdirSync(imagesDir, { recursive: true });
    }
    
    const imagePath = path.join(imagesDir, filename);
    fs.writeFileSync(imagePath, buffer);
    console.log(`  ✓ Downloaded: ${filename}`);
    return `images/${filename}`;
  } catch (e) {
    console.log(`  ✗ Failed to download image: ${e.message}`);
    return null;
  }
}

// A site's og:image is whatever the owner (or their builder) put there, and
// nothing checks it still exists: expired LinkedIn links, deleted files, even
// the literal string "[object Object]". Confirm it actually serves an image.
async function isWorkingImage(imageUrl) {
  // Some CDNs (Cargo) refuse a browser user agent that doesn't come from a
  // real browser, yet serve node-fetch's own - so either one passing will do.
  return await imageLoads(imageUrl, BROWSER_USER_AGENT) || await imageLoads(imageUrl);
}

async function imageLoads(imageUrl, userAgent) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  try {
    new URL(imageUrl);
    const response = await fetch(imageUrl, {
      headers: userAgent ? { 'User-Agent': userAgent } : {},
      signal: controller.signal
    });
    const type = response.headers.get('content-type') || '';
    return response.ok && type.startsWith('image/');
  } catch (e) {
    return false;
  } finally {
    // Only the headers matter; abort rather than pull down a multi-megabyte
    // original. (Destroying the body alone leaves the socket open.)
    clearTimeout(timer);
    controller.abort();
  }
}

function screenshotFilename(url) {
  // Keep the query string: every YouTube link is /watch, differing only in ?v=
  const { hostname, pathname, search } = new URL(url);
  const slug = slugify(`${hostname.replace('www.', '')} ${pathname} ${search}`.replace(/[./?=&]/g, ' ')).replace(/-+$/, '');
  return `screenshot_${slug}.jpg`;
}

// One Chrome instance shared by every screenshot; closed at the end of build().
let browserPromise = null;
function getBrowser() {
  if (!browserPromise) {
    browserPromise = puppeteer.launch({ executablePath: CHROME_PATH, headless: true });
  }
  return browserPromise;
}

async function closeBrowser() {
  if (browserPromise) await (await browserPromise).close();
}

// Screenshot the top of the page in headless Chrome. For a portfolio site
// this beats both a placeholder and guessing at the first <img> on the page.
async function screenshotSite(url, filename) {
  if (!fs.existsSync(CHROME_PATH)) return null;

  const imagesDir = path.join('dist', 'images');
  fs.mkdirSync(imagesDir, { recursive: true });
  const imagePath = path.join(imagesDir, filename);

  let page;
  try {
    page = await (await getBrowser()).newPage();
    await page.setViewport({ width: 1280, height: 800 });
    await page.setUserAgent(BROWSER_USER_AGENT);

    // Some sites never finish loading (endless video, polling), so don't
    // insist on it: shoot whatever has rendered once the time is up.
    try {
      await page.goto(url, { waitUntil: 'load', timeout: 20000 });
    } catch (e) {
      if (!/timeout/i.test(e.message)) throw e;
    }
    // Let intro animations and lazy-loaded images settle
    await new Promise(resolve => setTimeout(resolve, 3000));

    await page.screenshot({
      path: imagePath,
      type: 'jpeg',
      quality: 75,
      // Scale the 1280px viewport down to 800px, plenty for a card
      clip: { x: 0, y: 0, width: 1280, height: 800, scale: 0.625 }
    });
    console.log(`  ✓ Screenshot: ${filename}`);
    return `images/${filename}`;
  } catch (e) {
    console.log(`  ✗ Screenshot failed: ${e.message}`);
    // A screenshot from a previous build is better than nothing
    return fs.existsSync(imagePath) ? `images/${filename}` : null;
  } finally {
    if (page) await page.close().catch(() => {});
  }
}

// Handle Instagram URLs specifically
async function scrapeInstagramMetadata(url) {
  try {
    console.log(`  Scraping Instagram: ${url}`);
    
    // Extract post ID from URL
    const postIdMatch = url.match(/\/p\/([A-Za-z0-9_-]+)/);
    if (!postIdMatch) {
      return null;
    }
    
    const postId = postIdMatch[1];
    
    // Try multiple approaches to get Instagram thumbnail
    
    // Approach 1: Try to fetch the page and extract metadata
    try {
      const response = await fetch(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
          'Accept-Language': 'en-US,en;q=0.5',
          'Sec-Fetch-Dest': 'document',
          'Sec-Fetch-Mode': 'navigate',
          'Sec-Fetch-Site': 'none'
        },
        timeout: 10000
      });
      
      if (response.ok) {
        const html = await response.text();
        const $ = cheerio.load(html);
        
        // Try to get title from og:title
        let title = $('meta[property="og:title"]').attr('content') || '@instagram';
        
        // Try to get the image from og:image
        let imageUrl = $('meta[property="og:image"]').attr('content') || '';
        
        // Clean up the title
        title = title.replace(/\s+on Instagram:.*$/i, '').trim();
        if (title.length > 60) {
          title = title.substring(0, 57) + '...';
        }
        
        console.log(`  Title: ${title}`);
        
        // If we found an image URL, try to download it locally
        if (imageUrl) {
          console.log(`  Found image URL, downloading...`);
          const filename = `instagram_${postId}.jpg`;
          const localPath = await downloadImage(imageUrl, filename);
          
          if (localPath) {
            return {
              image: localPath,
              title: title
            };
          } else {
            // Download failed but we have the URL, use it directly (may expire)
            console.log(`  Using direct URL (may expire later)`);
            return {
              image: imageUrl,
              title: title
            };
          }
        }
      }
    } catch (e) {
      console.log(`  Page fetch failed: ${e.message}`);
    }
    
    // Fallback: use Instagram-branded placeholder
    console.log(`  Using placeholder image`);
    return {
      image: `https://placehold.co/600x600/E4405F/ffffff?text=Instagram+Post&font=roboto`,
      title: 'Instagram Post'
    };
  } catch (e) {
    console.log(`  Instagram scraping failed: ${e.message}`);
  }
  
  return null;
}

// Scrape metadata from a URL
async function scrapeMetadata(url) {
  try {
    console.log(`Scraping: ${url}`);
    
    // Special handling for Instagram URLs
    if (url.includes('instagram.com')) {
      const instagramData = await scrapeInstagramMetadata(url);
      if (instagramData && instagramData.image) {
        return {
          url,
          title: instagramData.title || '@instagram',
          description: '',
          image: instagramData.image,
          success: true
        };
      }
    }
    
    let response = await fetch(url, {
      headers: { 'User-Agent': BROWSER_USER_AGENT },
      timeout: 10000
    });

    // Retry refused requests as a link-preview crawler before giving up.
    if (response.status === 403 || response.status === 401) {
      console.log(`  HTTP ${response.status}, retrying as link preview crawler...`);
      response = await fetch(url, {
        headers: { 'User-Agent': PREVIEW_USER_AGENT },
        timeout: 10000
      });
    }

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    const html = await response.text();
    const $ = cheerio.load(html);
    
    // Try to get Open Graph metadata first, then fall back to other methods
    let title = $('meta[property="og:title"]').attr('content') || 
                $('meta[name="twitter:title"]').attr('content') ||
                $('title').text() ||
                new URL(url).hostname;
    
    // Take the first candidate that's actually useful. Some sites (Behance)
    // set twitter:description to a copy of the title, so a plain || chain
    // stops on a useless value instead of falling through to a real one.
    const descriptionCandidates = [
      $('meta[property="og:description"]').attr('content'),
      $('meta[name="twitter:description"]').attr('content'),
      $('meta[name="description"]').attr('content'),
    ];

    let description = descriptionCandidates.find(candidate => {
      if (!candidate) return false;
      const text = candidate.trim();
      if (isGenericDescription(text, url)) return false;
      // A description that just repeats the title adds nothing to the card.
      return text.toLowerCase() !== title.trim().toLowerCase();
    }) || '';

    let image = $('meta[property="og:image"]').attr('content') ||
                $('meta[name="twitter:image"]').attr('content') ||
                '';

    // Make image URL absolute if it's relative
    if (image && !image.startsWith('http')) {
      const urlObj = new URL(url);
      if (image.startsWith('//')) {
        image = 'https:' + image;
      } else if (image.startsWith('/')) {
        image = urlObj.origin + image;
      } else {
        image = urlObj.origin + '/' + image;
      }
    }

    // Force HTTPS for images
    if (image && image.startsWith('http://')) {
      image = image.replace('http://', 'https://');
    }

    if (image && !(await isWorkingImage(image))) {
      console.log(`  OG image doesn't load: ${image.substring(0, 60)}...`);
      image = '';
    }

    // No usable OG image: screenshot the site, or failing that, guess at the
    // first suitable image on the page (often a nav icon or blurred preview).
    const canScreenshot = !NO_SCREENSHOT_HOSTS.some(host => new URL(url).hostname.endsWith(host));
    if (!image && canScreenshot) {
      console.log('  No usable OG image, taking screenshot...');
      image = await screenshotSite(url, screenshotFilename(url));
    }
    if (!image) {
      console.log('  Searching page for images...');
      const found = findFirstImage($, url);
      if (found && await isWorkingImage(found)) {
        image = found;
        console.log(`  Found image: ${image.substring(0, 60)}...`);
      }
    }

    // Pull down images from hosts that don't survive hotlinking
    if (image && CACHE_IMAGES_FROM.some(host => new URL(url).hostname.endsWith(host))) {
      const ext = (image.split('?')[0].match(/\.(jpe?g|png|webp|gif)$/i) || ['.jpg'])[0];
      const filename = `${slugify(new URL(url).hostname.replace('www.', ''))}_${slugify(path.basename(new URL(url).pathname))}${ext}`;

      // Prefer the smaller render, but fall back if this asset has no variant.
      const smaller = smallerBehanceVariant(image);
      const localPath = (smaller && await downloadImage(smaller, filename))
        || await downloadImage(image, filename);

      if (localPath) image = localPath;
    }

    // If still no image, use generic placeholder
    if (!image) {
      const hostname = new URL(url).hostname.replace('www.', '');
      image = placeholderImage(hostname);
      console.log('  Using placeholder image');
    }

    // Truncate description if too long
    if (description && description.length > 200) {
      description = description.substring(0, 200) + '...';
    }
    
    return {
      url,
      title: title.trim(),
      description: description.trim(),
      image,
      success: true
    };
  } catch (error) {
    console.error(`Error scraping ${url}: ${error.message}`);
    // Return fallback data. No screenshot here: a site that refuses the
    // scraper usually serves a bot check to headless Chrome too.
    const hostname = new URL(url).hostname.replace('www.', '');
    return {
      url,
      title: hostname,
      description: '',
      image: placeholderImage(hostname),
      success: false
    };
  }
}

// Poster frame that sits alongside each encoded clip (written by encode-videos.js)
function posterPath(file) {
  return `videos/posters/${file.replace(/\.mp4$/, '.jpg')}`;
}

// Generate HTML for a video gallery page
function generateVideoPage(collection) {
  const items = collection.videos.map(video => `
    <figure class="video-item">
      <video
        class="video-player"
        src="videos/${video.file}"
        poster="${posterPath(video.file)}"
        autoplay
        loop
        muted
        playsinline
        preload="metadata"
      ></video>
      <figcaption class="video-caption">
        <a href="${video.url}" target="_blank" rel="noopener noreferrer">
          <span class="video-title">${escapeHtml(video.title)}</span>
          ${video.artist ? `<span class="video-artist">${escapeHtml(video.artist)}</span>` : ''}
        </a>
      </figcaption>
    </figure>
  `).join('');

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${collection.name}</title>
  <link rel="stylesheet" href="style.css">
</head>
<body>
  <div class="container">
    <header>
      <a href="index.html" class="back-link">← Back to Collections</a>
      <h1>${collection.name}</h1>
    </header>

    <div class="video-grid">
      ${items}
    </div>
  </div>
  <script>
    // The autoplay attribute does the actual work, so playback still happens if
    // this never runs. This only pauses what's scrolled out of view - a dozen
    // simultaneous loops is a lot of decoding, and mobile Safari caps how many
    // it will run at once anyway.
    const players = document.querySelectorAll('.video-player');

    if ('IntersectionObserver' in window) {
      const observer = new IntersectionObserver(entries => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            entry.target.play().catch(() => {});
          } else {
            entry.target.pause();
          }
        }
      }, { rootMargin: '200px 0px' });

      players.forEach(player => observer.observe(player));
    }
  </script>
</body>
</html>`;
}

// Generate HTML for home page
function generateHomePage(collections) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Resource Collections</title>
  <link rel="stylesheet" href="style.css">
</head>
<body>
  <div class="container">
    <header>
      <h1>Resource Collections</h1>
    </header>
    
    <div class="collections-grid">
      ${collections.map(col => {
        // Video collections preview with the first clip's poster frame;
        // link collections use the first scraped thumbnail.
        const previewImage = col.type === 'video'
          ? (col.videos[0] ? posterPath(col.videos[0].file) : '')
          : (col.metadata && col.metadata[0] ? col.metadata[0].image : '');
        const count = col.type === 'video' ? col.videos.length : col.links.length;
        // Video posters are portrait, so bias the crop upward onto the artwork
        // instead of the album title baked into the middle of the frame.
        const imageClass = col.type === 'video' ? 'collection-image collection-image-video' : 'collection-image';
        return `
        <a href="${col.slug}.html" class="collection-card">
          <div class="${imageClass}" style="background-image: url('${previewImage}')"></div>
          <div class="collection-info">
            <h2>${col.name}</h2>
            <span class="link-count">${count} resources</span>
          </div>
        </a>
      `;
      }).join('')}
    </div>
  </div>
</body>
</html>`;
}

// Generate HTML for a collection page
function generateCollectionPage(collection, allMetadata) {
  const cards = allMetadata.map(meta => {
    // Check if it's a YouTube or Instagram URL (no URL display for these)
    const isYouTube = meta.url.includes('youtube.com') || meta.url.includes('youtu.be');
    const isInstagram = meta.url.includes('instagram.com');
    const isVimeo = meta.url.includes('vimeo.com');
    
    // Hide URL for video/social media content
    const hideUrl = isYouTube || isInstagram || isVimeo;
    
    // Format URL for display (remove protocol and www)
    const displayUrl = meta.url.replace(/^https?:\/\/(www\.)?/, '').replace(/\/$/, '');
    
    return `
    <a href="${meta.url}" target="_blank" rel="noopener noreferrer" class="card">
      <div class="card-image" style="background-image: url('${meta.image}')"></div>
      <div class="card-content">
        <h3 class="card-title">${escapeHtml(meta.title)}</h3>
        ${meta.description ? `<p class="card-description">${escapeHtml(meta.description)}</p>` : ''}
        ${!hideUrl ? `<p class="card-url">${escapeHtml(displayUrl)}</p>` : ''}
      </div>
    </a>
  `;
  }).join('');
  
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${collection.name}</title>
  <link rel="stylesheet" href="style.css">
</head>
<body>
  <div class="container">
    <header>
      <a href="index.html" class="back-link">← Back to Collections</a>
      <h1>${collection.name}</h1>
    </header>
    
    <div class="cards-grid">
      ${cards}
    </div>
  </div>
</body>
</html>`;
}

// Escape HTML special characters
function escapeHtml(text) {
  const map = {
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#039;'
  };
  return text.replace(/[&<>"']/g, m => map[m]);
}

// Scraped metadata, keyed by URL. Scraping every link takes around ten
// minutes, so each one is scraped once and reused on later builds.
const CACHE_FILE = 'scrape-cache.json';

function loadCache() {
  try {
    return JSON.parse(fs.readFileSync(CACHE_FILE, 'utf-8'));
  } catch (e) {
    return {};
  }
}

function saveCache(cache) {
  // Sorted keys keep the diff readable when links are added
  const sorted = Object.fromEntries(Object.entries(cache).sort(([a], [b]) => a.localeCompare(b)));
  fs.writeFileSync(CACHE_FILE, JSON.stringify(sorted, null, 2) + '\n');
}

// A cached entry is only reusable if the image it points at is still there.
function isUsableCacheEntry(meta) {
  if (!meta || meta.image.startsWith('data:')) return false;
  if (meta.image.startsWith('images/')) return fs.existsSync(path.join('dist', meta.image));
  return true;
}

// --refresh re-scrapes everything; --refresh "Alumni Websites" (or the page
// slug, alumni-websites) re-scrapes just that section. Repeatable.
function parseRefreshArgs(argv) {
  const sections = [];
  let all = false;
  argv.forEach((arg, i) => {
    if (arg !== '--refresh') return;
    const next = argv[i + 1];
    if (next && !next.startsWith('--')) sections.push(next.toLowerCase());
    else all = true;
  });
  return collection => all ||
    sections.includes(collection.name.toLowerCase()) || sections.includes(collection.slug);
}

// Main build function
async function build() {
  // --videos-only rebuilds just the galleries and CSS, leaving the link pages
  // as they are.
  const videosOnly = process.argv.includes('--videos-only');
  const shouldRefresh = parseRefreshArgs(process.argv);
  const cache = loadCache();

  console.log(`Starting build${videosOnly ? ' (videos only)' : ''}...\n`);

  // Parse links file
  const linkCollections = parseLinksFile('links.md');
  // Video collections come from local files, so there's nothing to scrape.
  const videoCollections = parseVideosFile('videos.md');
  const collections = [...linkCollections, ...videoCollections];
  console.log(`Found ${linkCollections.length} link collections, ${videoCollections.length} video collections\n`);

  // Scrape metadata for new links; reuse the cache for the rest
  for (const collection of videosOnly ? [] : linkCollections) {
    const refresh = shouldRefresh(collection);
    console.log(`Processing collection: ${collection.name}${refresh ? ' (refreshing)' : ''}`);
    const metadata = [];
    let reused = 0;

    for (const url of collection.links) {
      const cached = cache[url];
      if (!refresh && isUsableCacheEntry(cached)) {
        metadata.push({ url, ...cached, success: true });
        reused++;
        continue;
      }

      const meta = await scrapeMetadata(url);
      // Don't cache a placeholder: retry it next build in case the site's back
      if (meta.success && !meta.image.startsWith('data:')) {
        const { url: _, success, ...stored } = meta;
        cache[url] = stored;
        saveCache(cache);
        metadata.push(meta);
      } else if (isUsableCacheEntry(cached)) {
        // Site down or rate limiting us: keep the card as it was
        console.log('  Keeping previous version of this card');
        metadata.push({ url, ...cached, success: true });
      } else {
        metadata.push(meta);
      }
      // Small delay to be respectful to servers
      await new Promise(resolve => setTimeout(resolve, 500));
    }

    if (reused) console.log(`  ${reused} link(s) reused from ${CACHE_FILE}`);

    collection.metadata = metadata;
    console.log('');
  }
  await closeBrowser();

  // Ensure dist directory exists
  if (!fs.existsSync('dist')) {
    fs.mkdirSync('dist', { recursive: true });
  }
  
  // Without scraped metadata the link cards would come out blank, so in
  // videos-only mode leave the home page and link pages untouched.
  if (videosOnly) {
    console.log('Skipped: index.html and link collection pages (run a full build to refresh them)');
  } else {
    const homePage = generateHomePage(collections);
    fs.writeFileSync('dist/index.html', homePage);
    console.log('Generated: index.html');

    for (const collection of linkCollections) {
      const collectionPage = generateCollectionPage(collection, collection.metadata);
      fs.writeFileSync(`dist/${collection.slug}.html`, collectionPage);
      console.log(`Generated: ${collection.slug}.html`);
    }
  }

  // Generate video gallery pages
  for (const collection of videoCollections) {
    const missing = collection.videos.filter(v => !fs.existsSync(path.join('dist', 'videos', v.file)));
    if (missing.length) {
      console.log(`  ! ${missing.length} clip(s) not found in dist/videos - run: npm run encode`);
    }
    fs.writeFileSync(`dist/${collection.slug}.html`, generateVideoPage(collection));
    console.log(`Generated: ${collection.slug}.html`);
  }
  
  // Copy CSS file
  fs.copyFileSync('src/style.css', 'dist/style.css');
  console.log('Copied: style.css');
  
  console.log('\nBuild complete! Open dist/index.html to view.');
}

// Run build
build().catch(error => {
  console.error('Build failed:', error);
  process.exit(1);
});
