// scripts/flipkart-fetch.js
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');

puppeteer.use(StealthPlugin());

// ========================================================
// ✅ CRITICAL FIX: Handle uncaught errors properly
// ========================================================
process.on('uncaughtException', async (err) => {
  console.error('💥 Uncaught Exception:', err);
  process.exit(1);
});

process.on('unhandledRejection', async (reason) => {
  console.error('💥 Unhandled Rejection:', reason);
  process.exit(1);
});

async function scrapeFlipkartPrice(browser, url) {
  const page = await browser.newPage();
  await page.setViewport({ width: 1366, height: 768 });

  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await new Promise(r => setTimeout(r, Math.floor(Math.random() * 2000) + 2000));

    const result = await page.evaluate(() => {
      let price = null;
      let is_out_of_stock = false;

      // ========== CHECK OUT OF STOCK STATUS ==========
      const pageText = document.body.innerText.toLowerCase();
      const outOfStockIndicators = [
        'out of stock',
        'currently unavailable',
        'not available',
        'sold out',
        'this item is not currently available'
      ];

      is_out_of_stock = outOfStockIndicators.some(indicator => pageText.includes(indicator));

      // Also check for disabled add to cart button
      if (!is_out_of_stock) {
        const addToCartBtn = document.querySelector('button[aria-label*="Add to cart"], button:contains("Add to cart")');
        if (addToCartBtn && addToCartBtn.disabled) {
          is_out_of_stock = true;
        }
      }

      // ========== EXTRACT PRICE ==========
      // 1. Try JSON-LD (Structured Data) first
      const jsonLd = Array.from(document.querySelectorAll('script[type="application/ld+json"]'));
      for (let script of jsonLd) {
        try {
          const data = JSON.parse(script.innerText);
          if (data['@type'] === 'Product' && data.offers && data.offers.price) {
            price = data.offers.price;
            break;
          }
          if (Array.isArray(data)) {
            const p = data.find(d => d['@type'] === 'Product');
            if (p && p.offers && p.offers.price) {
              price = p.offers.price;
              break;
            }
          }
        } catch (e) {}
      }

      // 2. Fallback to Visual Scraping
      if (!price) {
        const xpath = "//*[contains(text(), '₹')]|//*[contains(text(), 'Rs')]";
        const xpath_result = document.evaluate(xpath, document, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null);
        let maxFontSize = 0;
        let bestPriceText = null;

        for (let i = 0; i < xpath_result.snapshotLength; i++) {
          const el = xpath_result.snapshotItem(i);
          if (!el || el.offsetParent === null) continue;

          const style = window.getComputedStyle(el);
          const fontSize = parseFloat(style.fontSize) || 0;
          const text = el.innerText.trim();
          const isPrice = /^₹?\s*[\d,]+$/.test(text) || /^Rs\.??\s*[\d,]+$/.test(text);

          if (isPrice && fontSize > maxFontSize) {
            maxFontSize = fontSize;
            bestPriceText = text;
          }
        }
        price = bestPriceText;
      }

      return { price, is_out_of_stock };
    });

    if (result.price) {
      result.price = parseInt(result.price.toString().replace(/[^\d]/g, ''), 10);
    }

    await page.close();
    return result;

  } catch (error) {
    console.log(` ⚠️ Fetch Error: ${error.message}`);
    try { await page.close(); } catch(e) {}
    return { price: null, is_out_of_stock: false };
  }
}

async function run() {
  console.log('🚀 Starting Flipkart Direct Scrape Test...');
  
  // Replace this with the target Flipkart product URL
  const testUrl = 'https://www.flipkart.com/apple-iphone-15-black-128-gb/p/itm6ac6485515ae4';
  
  console.log(`🔄 Fetching URL: ${testUrl}`);

  const browser = await puppeteer.launch({
    headless: true, // ✅ Set to true for server execution
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-accelerated-2d-canvas',
      '--disable-gpu'
    ]
  });

  try {
    const result = await scrapeFlipkartPrice(browser, testUrl);
    console.log('\n📊 SCRAPE RESULT:');
    console.log('='.repeat(40));
    console.log(`Price: ₹${result.price || 'Not Found'}`);
    console.log(`Out of Stock: ${result.is_out_of_stock ? 'Yes' : 'No'}`);
    console.log('='.repeat(40));
  } catch (error) {
    console.error('❌ Error during scrape:', error);
  } finally {
    console.log('\n⏳ Closing browser...');
    await browser.close();
    console.log('✅ Done.');
    process.exit(0);
  }
}

// ✅ Catch unhandled errors
run().catch(err => {
  console.error('💥 Unhandled error in run():', err);
  process.exit(1);
});