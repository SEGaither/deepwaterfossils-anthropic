/**
 * DeepWaterFossils — Product Image Collector
 * Uses Playwright with a persistent browser session (manual login on first run).
 * Collects STILL IMAGES ONLY. Videos and video thumbnails are excluded.
 *
 * Usage:
 *   node scripts/collect-product-images.js
 *
 * First run: browser opens, navigate to etsy.com, log in, then press Enter in terminal.
 * Subsequent runs: saved session is reused automatically.
 */

'use strict';

const { chromium } = require('playwright');
const fs   = require('fs');
const path = require('path');
const https = require('https');
const http  = require('http');
const readline = require('readline');

// ── Paths ────────────────────────────────────────────────────────────────────
const ROOT         = path.join(__dirname, '..');
const SESSION_DIR  = path.join(ROOT, '.playwright-session');
const ASSETS_DIR   = path.join(ROOT, 'assets', 'products');
const AUDIT_FILE   = path.join(ROOT, 'product-image-audit.json');
const MANIFEST_JSON = path.join(ROOT, 'product-image-manifest.json');
const MANIFEST_CSV  = path.join(ROOT, 'product-image-manifest.csv');
const FAILURES_FILE = path.join(ROOT, 'product-image-failures.txt');

// ── Config ───────────────────────────────────────────────────────────────────
const DELAY_MS        = 3000;   // pause between listings (ms)
const NAV_TIMEOUT     = 30000;  // page navigation timeout
const ELEMENT_TIMEOUT = 15000;  // element wait timeout
const THUMB_PAUSE_MS  = 900;    // pause after clicking each thumbnail

// ── URL filters ──────────────────────────────────────────────────────────────
const VIDEO_PATTERNS = [
  /\.mp4(\?|$)/i, /\.webm(\?|$)/i, /\.mov(\?|$)/i,
  /etsyvideo/i, /etsy_video/i, /video_file/i,
  /\/videos?\//i,
];

const STILL_IMAGE_PATTERNS = [
  /etsystatic\.com.*\.(jpg|jpeg|png|webp)(\?|$)/i,
];

function isVideo(url)      { return VIDEO_PATTERNS.some(p => p.test(url)); }
function isStillImage(url) { return STILL_IMAGE_PATTERNS.some(p => p.test(url)) && !isVideo(url); }

// Prefer fullxfull resolution; fall back to original URL if upgrade fails.
function upgradeResolution(url) {
  return url
    .replace(/il_\d+xN\./g,    'il_fullxfull.')
    .replace(/il_\d+x\d+\./g,  'il_fullxfull.')
    .replace(/([?&])rns=\d+/g,  '$1')
    .replace(/\?$/,              '');
}

// ── Image downloader ──────────────────────────────────────────────────────────
function downloadFile(url, dest) {
  return new Promise((resolve, reject) => {
    const proto = url.startsWith('https') ? https : http;
    const file  = fs.createWriteStream(dest);

    const req = proto.get(url, { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' } }, (res) => {
      if (res.statusCode === 301 || res.statusCode === 302) {
        file.close();
        fs.unlink(dest, () => {});
        downloadFile(res.headers.location, dest).then(resolve).catch(reject);
        return;
      }
      if (res.statusCode !== 200) {
        file.close();
        fs.unlink(dest, () => {});
        reject(new Error(`HTTP ${res.statusCode} for ${url}`));
        return;
      }
      res.pipe(file);
      file.on('finish', () => { file.close(); resolve(); });
    });

    req.on('error', (err) => { file.close(); fs.unlink(dest, () => {}); reject(err); });
    req.setTimeout(20000, () => { req.destroy(); reject(new Error('Download timeout')); });
  });
}

// ── Prompt helper ─────────────────────────────────────────────────────────────
function waitForEnter(msg) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(msg, () => { rl.close(); resolve(); });
  });
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── Video thumbnail detection ─────────────────────────────────────────────────
const VIDEO_THUMB_SELECTORS = [
  '[aria-label*="video" i]',
  '[aria-label*="Video"]',
  '[data-media-type="video"]',
  '[class*="video" i][role="button"]',
  '[class*="VideoThumb"]',
  'button:has([class*="play-button" i])',
  '[class*="PlayButton"]',
];

async function countVideoThumbnails(page) {
  let max = 0;
  for (const sel of VIDEO_THUMB_SELECTORS) {
    try {
      const els = await page.$$(sel);
      if (els.length > max) max = els.length;
    } catch (_) {}
  }
  return max;
}

// ── Thumbnail button selectors (tried in order) ───────────────────────────────
const THUMB_BTN_SELECTORS = [
  '[data-carousel-pagination-button]',
  'ul[aria-label*="Photo" i] li button',
  'ul[aria-label*="Listing image" i] li button',
  '.carousel-pagination-list button',
  '[class*="CarouselPagination"] button',
  '[class*="thumbnail" i] button',
  '[class*="Thumbnail" i] button',
  '[class*="listing-image" i] button',
];

// ── Main image selectors (tried in order after thumbnail click) ────────────────
const MAIN_IMG_SELECTORS = [
  '[data-zkep-imgid] img',
  'figure img[src*="etsystatic.com"]',
  '[class*="carousel" i] img[src*="etsystatic.com"]',
  '[class*="MainImage" i] img',
  '[aria-label*="Listing image" i] img',
  'img[src*="etsystatic.com"][width]',
];

// ── Per-listing collector ─────────────────────────────────────────────────────
async function collectListing(page, listing) {
  const result = {
    productIndex:       listing.productIndex,
    productTitle:       listing.productTitle,
    etsyUrl:            listing.etsyUrl,
    downloadedImages:   [],
    expectedPhotoCount: null,
    downloadedImageCount: 0,
    status:  'pending',
    notes:   '',
  };

  const capturedUrls = new Set();

  // Intercept network — capture etsystatic image responses
  const responseHandler = (response) => {
    const url = response.url();
    if (isStillImage(url)) capturedUrls.add(upgradeResolution(url));
  };
  page.on('response', responseHandler);

  try {
    // Navigate
    await page.goto(listing.etsyUrl, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT });

    // Detect login redirect
    if (page.url().includes('/signin') || page.url().includes('/login')) {
      page.off('response', responseHandler);
      result.status = 'failed_partial_photo_capture';
      result.notes  = 'Session expired — Etsy redirected to login. Re-run after logging in again.';
      return result;
    }

    // Detect unavailable listing
    const pageTitle = await page.title().catch(() => '');
    if (/page not found|404|unavailable|removed/i.test(pageTitle)) {
      page.off('response', responseHandler);
      result.status = 'failed_listing_unavailable';
      result.notes  = `Listing page returned: "${pageTitle}"`;
      return result;
    }

    // Wait for at least one product image
    await page.waitForSelector('img[src*="etsystatic.com"]', { timeout: ELEMENT_TIMEOUT }).catch(() => {});
    await sleep(1000);

    // Find thumbnail buttons
    let thumbButtons = [];
    for (const sel of THUMB_BTN_SELECTORS) {
      const found = await page.$$(sel).catch(() => []);
      if (found.length > 0) { thumbButtons = found; break; }
    }

    // Count video thumbnails among them
    const videoThumbCount = await countVideoThumbnails(page);

    // Click each thumbnail; skip ones with video indicators
    for (let i = 0; i < thumbButtons.length; i++) {
      try {
        const btn        = thumbButtons[i];
        const ariaLabel  = (await btn.getAttribute('aria-label').catch(() => '') || '').toLowerCase();
        const mediaType  = (await btn.getAttribute('data-media-type').catch(() => '') || '').toLowerCase();

        if (ariaLabel.includes('video') || mediaType.includes('video')) continue;

        // Check child elements for video signals
        const hasPlay = await btn.$('[class*="play" i], [aria-label*="play" i]').catch(() => null);
        if (hasPlay) continue;

        await btn.scrollIntoViewIfNeeded().catch(() => {});
        await btn.click().catch(() => {});
        await sleep(THUMB_PAUSE_MS);

        // Grab main image src after click
        for (const imgSel of MAIN_IMG_SELECTORS) {
          const imgEl = await page.$(imgSel).catch(() => null);
          if (!imgEl) continue;
          const src = await imgEl.getAttribute('src').catch(() => '')
                   || await imgEl.getAttribute('data-src').catch(() => '') || '';
          if (src && isStillImage(src)) {
            capturedUrls.add(upgradeResolution(src));
            break;
          }
        }
      } catch (_) { /* non-fatal — continue */ }
    }

    // Scroll to trigger lazy-loading
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight)).catch(() => {});
    await sleep(800);
    await page.evaluate(() => window.scrollTo(0, 0)).catch(() => {});
    await sleep(400);

    // Final DOM sweep for any remaining etsystatic images
    const domImgs = await page.$$eval(
      'img[src*="etsystatic.com"]',
      (imgs) => imgs.map(i => i.src).filter(Boolean),
    ).catch(() => []);

    domImgs.forEach(url => { if (isStillImage(url)) capturedUrls.add(upgradeResolution(url)); });

    // Deduplicate by image ID (the numeric ID in the Etsy CDN URL)
    const idPattern = /\/(\d{10,})\//;
    const seenIds   = new Set();
    const uniqueUrls = [];

    for (const url of capturedUrls) {
      const match = url.match(idPattern);
      const id    = match ? match[1] : url;
      if (!seenIds.has(id)) {
        seenIds.add(id);
        uniqueUrls.push(url);
      }
    }

    // Determine expectedPhotoCount
    if (thumbButtons.length > 0) {
      result.expectedPhotoCount = thumbButtons.length - videoThumbCount;
    } else if (uniqueUrls.length > 0) {
      result.expectedPhotoCount = uniqueUrls.length; // best estimate from DOM
    } else {
      page.off('response', responseHandler);
      result.status = 'failed_expected_photo_count_unknown';
      result.notes  = 'No thumbnail buttons found and no etsystatic images detected on page.';
      return result;
    }

    if (result.expectedPhotoCount <= 0) {
      page.off('response', responseHandler);
      result.status = 'failed_expected_photo_count_unknown';
      result.notes  = 'All thumbnails identified as video; expected still-photo count is zero.';
      return result;
    }

    // Create product directory
    const productDir = path.join(ASSETS_DIR, `product-${String(listing.productIndex).padStart(3, '0')}`);
    fs.mkdirSync(productDir, { recursive: true });

    // Download each still image
    let imgNum = 1;
    for (const imgUrl of uniqueUrls) {
      const extMatch = imgUrl.match(/\.(jpg|jpeg|png|webp)(\?|$)/i);
      const ext      = extMatch ? extMatch[1].toLowerCase() : 'jpg';
      const filename = `image-${String(imgNum).padStart(2, '0')}.${ext}`;
      const destPath = path.join(productDir, filename);
      const relPath  = `assets/products/product-${String(listing.productIndex).padStart(3, '0')}/${filename}`;

      try {
        await downloadFile(imgUrl, destPath);
        result.downloadedImages.push(relPath);
        imgNum++;
        process.stdout.write(`  ✓ ${filename}\n`);
      } catch (dlErr) {
        result.notes += `Download failed for image ${imgNum} (${dlErr.message}). `;
        process.stdout.write(`  ✗ image-${String(imgNum).padStart(2, '0')} failed: ${dlErr.message}\n`);
        imgNum++;
      }
    }

    result.downloadedImageCount = result.downloadedImages.length;

    if (result.downloadedImageCount === result.expectedPhotoCount) {
      result.status = 'complete';
    } else if (result.downloadedImageCount > 0) {
      result.status = 'failed_partial_photo_capture';
      result.notes  += `Expected ${result.expectedPhotoCount} still photos, captured ${result.downloadedImageCount}.`;
    } else {
      result.status = 'failed_partial_photo_capture';
      result.notes  += 'No images were successfully downloaded.';
    }

  } catch (err) {
    result.status = err.message.includes('Timeout') ? 'failed_timeout' : 'failed_partial_photo_capture';
    result.notes  = err.message;
  }

  page.off('response', responseHandler);
  return result;
}

// ── Manifest writers ──────────────────────────────────────────────────────────
function writeManifests(results) {
  // JSON
  const jsonRecords = results.map(r => {
    const rec = {
      productIndex:         r.productIndex,
      productTitle:         r.productTitle,
      etsyUrl:              r.etsyUrl,
      imageCount:           r.downloadedImageCount,
      status:               r.status,
      notes:                r.notes,
    };
    for (let i = 1; i <= 10; i++) {
      rec[`downloadedImage${i}`] = r.downloadedImages[i - 1] || '';
    }
    return rec;
  });
  fs.writeFileSync(MANIFEST_JSON, JSON.stringify(jsonRecords, null, 2));

  // CSV
  const headers = [
    'productIndex','productTitle','etsyUrl',
    ...Array.from({length:10}, (_,i) => `downloadedImage${i+1}`),
    'imageCount','status','notes',
  ];
  const rows = [headers.join(',')];
  for (const r of jsonRecords) {
    const cells = headers.map(h => {
      const val = String(r[h] ?? '').replace(/"/g, '""');
      return `"${val}"`;
    });
    rows.push(cells.join(','));
  }
  fs.writeFileSync(MANIFEST_CSV, rows.join('\n'));

  // Failures
  const failures = results.filter(r => r.status !== 'complete');
  if (failures.length > 0) {
    const lines = ['PRODUCT IMAGE COLLECTION — FAILURE REPORT', '='.repeat(60), ''];
    for (const f of failures) {
      lines.push(`[${f.productIndex}] ${f.productTitle}`);
      lines.push(`  Etsy URL : ${f.etsyUrl}`);
      lines.push(`  Status   : ${f.status}`);
      lines.push(`  Expected : ${f.expectedPhotoCount ?? 'unknown'}`);
      lines.push(`  Got      : ${f.downloadedImageCount}`);
      if (f.notes) lines.push(`  Notes    : ${f.notes}`);
      lines.push('');
    }
    fs.writeFileSync(FAILURES_FILE, lines.join('\n'));
    console.log(`\nFailure report written → product-image-failures.txt (${failures.length} products)`);
  } else {
    if (fs.existsSync(FAILURES_FILE)) fs.unlinkSync(FAILURES_FILE);
    console.log('\nAll products complete — no failures.');
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────
(async () => {
  // Load listing data
  if (!fs.existsSync(AUDIT_FILE)) {
    console.error('ERROR: product-image-audit.json not found. Run the audit extraction first.');
    process.exit(1);
  }
  const listings = JSON.parse(fs.readFileSync(AUDIT_FILE, 'utf8'));
  console.log(`Loaded ${listings.length} listings from product-image-audit.json`);

  // Ensure assets dir exists
  fs.mkdirSync(ASSETS_DIR, { recursive: true });

  // Launch persistent browser context
  const isFirstRun = !fs.existsSync(SESSION_DIR);
  const context = await chromium.launchPersistentContext(SESSION_DIR, {
    headless:     false,
    viewport:     { width: 1280, height: 900 },
    userAgent:    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36',
    acceptDownloads: false,
  });

  const page = await context.newPage();

  // First-run login flow
  if (isFirstRun) {
    console.log('\n── FIRST RUN: MANUAL LOGIN REQUIRED ──────────────────────────────');
    console.log('A browser window has opened.');
    console.log('1. Navigate to https://www.etsy.com and log in to your shop.');
    console.log('2. Once you are logged in and can see your shop, return here.');
    await page.goto('https://www.etsy.com', { waitUntil: 'domcontentloaded' });
    await waitForEnter('\nPress Enter here when you are logged in to Etsy...');
    console.log('Login confirmed. Starting collection.\n');
  } else {
    console.log('Reusing saved session.\n');
  }

  const results = [];
  const total   = listings.length;

  for (let i = 0; i < listings.length; i++) {
    const listing = listings[i];
    const idx     = String(listing.productIndex).padStart(3, '0');
    console.log(`\n[${i + 1}/${total}] product-${idx} — ${listing.productTitle}`);
    console.log(`  ${listing.etsyUrl}`);

    const result = await collectListing(page, listing);
    results.push(result);

    const icon = result.status === 'complete' ? '✓' : '✗';
    console.log(`  ${icon} ${result.status} (${result.downloadedImageCount}/${result.expectedPhotoCount ?? '?'} photos)`);
    if (result.notes) console.log(`  Note: ${result.notes}`);

    // Pause between listings (skip after last)
    if (i < listings.length - 1) await sleep(DELAY_MS);
  }

  // Write outputs
  console.log('\n── Writing manifests ────────────────────────────────────────────────');
  writeManifests(results);
  console.log(`product-image-manifest.json → written`);
  console.log(`product-image-manifest.csv  → written`);

  // Summary
  const complete = results.filter(r => r.status === 'complete').length;
  const failed   = results.length - complete;
  console.log(`\n── Summary ──────────────────────────────────────────────────────────`);
  console.log(`  Total   : ${results.length}`);
  console.log(`  Complete: ${complete}`);
  console.log(`  Failed  : ${failed}`);

  await context.close();
  console.log('\nDone.');
})();
