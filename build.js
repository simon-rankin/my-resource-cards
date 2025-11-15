const fs = require('fs');
const path = require('path');
const fetch = require('node-fetch');
const cheerio = require('cheerio');

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

// Scrape metadata from a URL
async function scrapeMetadata(url) {
  try {
    console.log(`Scraping: ${url}`);
    
    const response = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
      },
      timeout: 10000
    });
    
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
    
    let description = $('meta[property="og:description"]').attr('content') ||
                     $('meta[name="twitter:description"]').attr('content') ||
                     $('meta[name="description"]').attr('content') ||
                     '';
    
    let image = $('meta[property="og:image"]').attr('content') ||
                $('meta[name="twitter:image"]').attr('content') ||
                '';
    
    // If no OG image found, try to find the first suitable image from the page
    if (!image) {
      console.log('  No OG image found, searching page for images...');
      image = findFirstImage($, url);
      if (image) {
        console.log(`  Found image: ${image.substring(0, 60)}...`);
      }
    }
    
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
    
    // If still no image, use generic placeholder
    if (!image) {
      const hostname = new URL(url).hostname.replace('www.', '');
      image = `https://via.placeholder.com/400x200/f5f5f5/666666?text=${encodeURIComponent(hostname)}`;
      console.log('  Using placeholder image');
    }
    
    // Filter out generic descriptions
    if (isGenericDescription(description, url)) {
      description = '';
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
    // Return fallback data
    const hostname = new URL(url).hostname.replace('www.', '');
    return {
      url,
      title: hostname,
      description: '',
      image: `https://via.placeholder.com/400x200/f5f5f5/666666?text=${encodeURIComponent(hostname)}`,
      success: false
    };
  }
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
    
    <div class="collections-list">
      ${collections.map(col => `
        <a href="${col.slug}.html" class="collection-link">
          <h2>${col.name}</h2>
          <span class="link-count">${col.links.length} resources</span>
        </a>
      `).join('')}
    </div>
  </div>
</body>
</html>`;
}

// Generate HTML for a collection page
function generateCollectionPage(collection, allMetadata) {
  const cards = allMetadata.map(meta => {
    // Check if it's a YouTube URL
    const isYouTube = meta.url.includes('youtube.com') || meta.url.includes('youtu.be');
    
    // Format URL for display (remove protocol and www)
    const displayUrl = meta.url.replace(/^https?:\/\/(www\.)?/, '').replace(/\/$/, '');
    
    return `
    <a href="${meta.url}" target="_blank" rel="noopener noreferrer" class="card">
      <div class="card-image" style="background-image: url('${meta.image}')"></div>
      <div class="card-content">
        <h3 class="card-title">${escapeHtml(meta.title)}</h3>
        ${!isYouTube ? `<p class="card-url">${escapeHtml(displayUrl)}</p>` : ''}
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

// Main build function
async function build() {
  console.log('Starting build...\n');
  
  // Parse links file
  const collections = parseLinksFile('links.md');
  console.log(`Found ${collections.length} collections\n`);
  
  // Scrape metadata for all links
  for (const collection of collections) {
    console.log(`Processing collection: ${collection.name}`);
    const metadata = [];
    
    for (const url of collection.links) {
      const meta = await scrapeMetadata(url);
      metadata.push(meta);
      // Small delay to be respectful to servers
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    
    collection.metadata = metadata;
    console.log('');
  }
  
  // Ensure dist directory exists
  if (!fs.existsSync('dist')) {
    fs.mkdirSync('dist', { recursive: true });
  }
  
  // Generate home page
  const homePage = generateHomePage(collections);
  fs.writeFileSync('dist/index.html', homePage);
  console.log('Generated: index.html');
  
  // Generate collection pages
  for (const collection of collections) {
    const collectionPage = generateCollectionPage(collection, collection.metadata);
    fs.writeFileSync(`dist/${collection.slug}.html`, collectionPage);
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
