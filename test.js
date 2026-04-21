// scripts/flipkart-fetch.js
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const puppeteerCore = require('puppeteer');

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

function extractFlipkartPid(productUrl) {
  try {
    return new URL(productUrl).searchParams.get('pid');
  } catch (error) {
    return null;
  }
}

async function scrapeFlipkartPrice(browser, url) {
  const page = await browser.newPage();
  await page.setViewport({ width: 1366, height: 768 });

  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await new Promise(r => setTimeout(r, Math.floor(Math.random() * 2000) + 2000));
    const finalUrl = page.url();

    const result = await page.evaluate(() => {
      let price = null;
      let original_price = null;
      let discount_percent = null;

      const getText = (element) => (element?.innerText || element?.textContent || '').trim().replace(/\s+/g, ' ');
      const parsePriceText = (text) => {
        if (!text) return null;
        const digits = text.replace(/[^\d]/g, '');
        return digits ? parseInt(digits, 10) : null;
      };
      const isVisible = (element) => {
        if (!(element instanceof HTMLElement)) return false;
        const rect = element.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) return false;
        const style = window.getComputedStyle(element);
        return style.display !== 'none' && style.visibility !== 'hidden';
      };

      // ========== CHECK OUT OF STOCK STATUS ==========
      const pageText = document.body.innerText.toLowerCase();
      const outOfStockIndicators = [
        'out of stock',
        'currently unavailable',
        'sold out',
        'this item is not currently available'
      ];

      const buttons = Array.from(document.querySelectorAll('button'));
      const normalizedButtonTexts = buttons
        .map((button) => ({
          text: (button.innerText || button.textContent || '').trim().toLowerCase(),
          disabled: button.disabled || button.getAttribute('aria-disabled') === 'true'
        }))
        .filter((button) => button.text);

      const hasAddToCartButton = normalizedButtonTexts.some((button) =>
        button.text.includes('add to cart') || button.text.includes('buy now')
      );

      const hasDisabledPurchaseButton = normalizedButtonTexts.some((button) =>
        button.disabled && (button.text.includes('add to cart') || button.text.includes('buy now'))
      );

      const unavailablePurchaseLabels = [
        'notify me',
        'coming soon',
        'notify when available'
      ];

      const hasOutOfStockText = outOfStockIndicators.some((indicator) => pageText.includes(indicator));
      const hasUnavailablePurchaseLabel = unavailablePurchaseLabels.some((label) => pageText.includes(label));

      // Visible purchase actions are a stronger signal than generic page text,
      // which often mentions stock for other variants on the same product page.
      const is_out_of_stock = hasAddToCartButton && !hasDisabledPurchaseButton
        ? false
        : hasDisabledPurchaseButton || hasOutOfStockText || (!hasAddToCartButton && hasUnavailablePurchaseLabel);

      // ========== EXTRACT PRICE ==========
      // 1. Prefer the rendered PDP price, not JSON-LD or offer-card values.
      const priceCandidates = Array.from(document.querySelectorAll('body *'))
        .filter((element) => isVisible(element))
        .map((element) => {
          const text = getText(element);
          const style = window.getComputedStyle(element);
          const rect = element.getBoundingClientRect();

          return {
            element,
            text,
            fontSize: parseFloat(style.fontSize) || 0,
            y: rect.y,
            x: rect.x,
            textDecoration: style.textDecorationLine
          };
        })
        .filter((item) => /^₹\s*[\d,]+$/.test(item.text))
        .filter((item) => item.y > 150)
        .sort((left, right) => right.fontSize - left.fontSize || left.y - right.y || left.x - right.x);

      if (priceCandidates.length > 0) {
        const selectedPrice = priceCandidates[0];
        price = parsePriceText(selectedPrice.text);

        const nearbyContainers = [
          selectedPrice.element.parentElement,
          selectedPrice.element.parentElement?.parentElement,
          selectedPrice.element.parentElement?.parentElement?.parentElement
        ].filter(Boolean);

        for (const container of nearbyContainers) {
          const containerText = getText(container);
          if (!containerText || containerText.length > 120) continue;

          const matchedPrices = [...containerText.matchAll(/₹\s*[\d,]+/g)]
            .map((match) => parsePriceText(match[0]))
            .filter((value) => value !== null);
          const lineThroughPrices = Array.from(container.querySelectorAll('*'))
            .filter((element) => isVisible(element))
            .map((element) => ({
              text: getText(element),
              textDecoration: window.getComputedStyle(element).textDecorationLine
            }))
            .filter((item) => item.textDecoration.includes('line-through'))
            .map((item) => parsePriceText(item.text))
            .filter((value) => value !== null);
          const discountMatch = containerText.match(/(\d+)%/);
          const largerPrice = matchedPrices.find((candidate) => candidate > price)
            || lineThroughPrices.find((candidate) => candidate > price);

          if (largerPrice || discountMatch) {
            original_price = largerPrice || null;
            discount_percent = discountMatch ? parseInt(discountMatch[1], 10) : null;
            break;
          }
        }
      }

      // 2. Fallback to JSON-LD when the rendered PDP price could not be found.
      if (!price) {
        const jsonLd = Array.from(document.querySelectorAll('script[type="application/ld+json"]'));
        for (let script of jsonLd) {
          try {
            const data = JSON.parse(script.innerText);
            if (data['@type'] === 'Product' && data.offers && data.offers.price) {
              price = data.offers.price;
              break;
            }
            if (Array.isArray(data)) {
              const product = data.find((item) => item['@type'] === 'Product');
              if (product && product.offers && product.offers.price) {
                price = product.offers.price;
                break;
              }
            }
          } catch (e) {}
        }
      }

      // 3. Final fallback: broad visual scan.
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
        price = parsePriceText(bestPriceText);
      }

      return {
        price,
        original_price,
        discount_percent,
        is_out_of_stock,
        page_title: document.title
      };
    });

    if (result.price) {
      result.price = parseInt(result.price.toString().replace(/[^\d]/g, ''), 10);
    }

    if (result.original_price) {
      result.original_price = parseInt(result.original_price.toString().replace(/[^\d]/g, ''), 10);
    }

    result.final_url = finalUrl;
    result.input_pid = extractFlipkartPid(url);
    result.final_pid = extractFlipkartPid(finalUrl);
    result.was_redirected = finalUrl !== url;

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
  const testUrl = process.argv[2] || 'https://www.flipkart.com/urbangabru-hair-volumizing-powder/p/itm5ff18b4d6db56?pid=HSTHA649Z4JFPWMG';
  
  console.log(`🔄 Fetching URL: ${testUrl}`);

  console.log("Resolved Chrome Path:", puppeteerCore.executablePath());
  
  const browser = await puppeteer.launch({
    headless: true, // ✅ Set to true for server execution
    executablePath: puppeteerCore.executablePath(),
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
    console.log(`Page Title: ${result.page_title || 'Not Found'}`);
    console.log(`Final URL: ${result.final_url || 'Not Found'}`);
    if (result.was_redirected || (result.input_pid && result.final_pid && result.input_pid !== result.final_pid)) {
      console.log(`URL Redirected: Yes (${result.input_pid || 'no pid'} -> ${result.final_pid || 'no pid'})`);
    }
    console.log(`Price: ₹${result.price || 'Not Found'}`);
    if (result.original_price) {
      console.log(`MRP: ₹${result.original_price}`);
    }
    if (result.discount_percent !== null && result.discount_percent !== undefined) {
      console.log(`Discount: ${result.discount_percent}%`);
    }
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
