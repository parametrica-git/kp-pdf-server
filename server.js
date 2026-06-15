// Серверный рендер КП в PDF.
// Принимает самодостаточный HTML текущего КП, печатает его настоящим Chromium и
// возвращает идеальный PDF: вектор, выделяемый текст, кликабельные ссылки, БЕЗ полей (@page A4, margin 0).
const express = require('express');
const cors = require('cors');
const puppeteer = require('puppeteer');

const app = express();
app.use(cors());                               // разрешить запросы с твоего хостинга (твой файл КП)
app.use(express.json({ limit: '40mb' }));      // КП с встроенными картинками — крупный JSON

// СЕКРЕТНЫЙ КЛЮЧ: если на сервере задана переменная окружения KP_TOKEN, то /pdf требует
// заголовок x-kp-key с тем же значением. Чужие запросы (без ключа) отклоняются.
const TOKEN = process.env.KP_TOKEN || '';

// один общий браузер на все запросы (быстрее, чем поднимать каждый раз)
let browserPromise = null;
async function getBrowser() {
  if (!browserPromise) {
    browserPromise = puppeteer.launch({
      headless: 'new',
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--font-render-hinting=none']
    }).catch(e => { browserPromise = null; throw e; });
  }
  const b = await browserPromise;
  if (!b.connected) { browserPromise = null; return getBrowser(); }   // переподнять, если упал
  return b;
}

app.get('/', (_req, res) => res.type('text/plain').send('KP PDF server OK. POST /pdf {html} -> application/pdf'));
app.get('/health', (_req, res) => res.json({ ok: true }));

app.post('/pdf', async (req, res) => {
  if (TOKEN && req.get('x-kp-key') !== TOKEN) return res.status(401).json({ error: 'unauthorized' });
  const html = req.body && req.body.html;
  if (!html || typeof html !== 'string') return res.status(400).json({ error: 'no html' });
  const name = (req.body.name || 'KP').toString().replace(/[\\/:*?"<>|\r\n]+/g, ' ').trim() || 'KP';
  let page;
  try {
    const browser = await getBrowser();
    page = await browser.newPage();
    await page.emulateMediaType('print');                         // применить @media print (скрытие контролов и т.п.)
    await page.setContent(html, { waitUntil: 'networkidle0', timeout: 90000 });
    try { await page.evaluate(() => document.fonts && document.fonts.ready); } catch (_) {}
    const pdf = await page.pdf({
      printBackground: true,
      preferCSSPageSize: true,                                    // размер берём из @page (A4 210×297)
      margin: { top: '0mm', right: '0mm', bottom: '0mm', left: '0mm' }
    });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'attachment; filename="' + encodeURIComponent(name) + '.pdf"');
    res.send(pdf);
  } catch (e) {
    console.error('PDF error:', e);
    res.status(500).json({ error: String(e && e.message || e) });
  } finally {
    if (page) { try { await page.close(); } catch (_) {} }
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('KP PDF server listening on ' + PORT));
