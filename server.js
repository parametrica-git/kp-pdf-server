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
    res.end(Buffer.from(pdf));   // pdf = Uint8Array; Buffer.from -> сырые байты (иначе Express отдаёт JSON-массив чисел)
  } catch (e) {
    console.error('PDF error:', e);
    res.status(500).json({ error: String(e && e.message || e) });
  } finally {
    if (page) { try { await page.close(); } catch (_) {} }
  }
});

// ===== ЗАЯВКА С САЙТА («Запросить КП») → Telegram + email =====
// env на Render: TG_TOKEN (бот @BotFather), TG_CHAT (ваш chat id), WEB3FORMS_KEY (web3forms.com)
const TG_TOKEN = process.env.TG_TOKEN || '';
const TG_CHAT  = process.env.TG_CHAT  || '';
const WEB3_KEY = process.env.WEB3FORMS_KEY || '';

function escTg(s){ return String(s == null ? '' : s).replace(/[<>&]/g, c => ({'<':'&lt;','>':'&gt;','&':'&amp;'}[c])); }
function formatLead(L){
  const c = L.contact || {}, d = L.delivery || {};
  let t = '🪑 <b>Новая заявка на КП</b>';
  t += '\n\n<b>Клиент:</b> ' + escTg(c.name) + (c.company ? ' (' + escTg(c.company) + ')' : '');
  t += '\n<b>Email:</b> ' + escTg(c.email);
  if (c.phone) t += '\n<b>Тел:</b> ' + escTg(c.phone);
  t += '\n<b>Доставка:</b> ' + escTg(d.country || '—') + (d.region ? ', ' + escTg(d.region) : '');
  if (L.comment) t += '\n<b>Комментарий:</b> ' + escTg(L.comment);
  (L.variants || []).forEach((v, i) => {
    t += '\n\n<b>' + escTg(v.name || ('Вариант ' + (i + 1))) + ':</b>\n' + (v.models || []).map(m => '• ' + escTg(m)).join('\n');
  });
  if (L.generatorUrl) t += '\n\n➡️ В генератор: ' + L.generatorUrl;
  return t;
}
app.post('/lead', async (req, res) => {
  const L = req.body || {};
  if (!L.contact || !L.contact.email) return res.status(400).json({ error: 'no contact' });
  const text = formatLead(L);
  const tasks = [];
  if (TG_TOKEN && TG_CHAT) tasks.push(fetch('https://api.telegram.org/bot' + TG_TOKEN + '/sendMessage', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: TG_CHAT, text, parse_mode: 'HTML', disable_web_page_preview: true })
  }).then(r => r.json()).catch(e => ({ tg_error: String(e) })));
  if (WEB3_KEY) tasks.push(fetch('https://api.web3forms.com/submit', {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
    body: JSON.stringify({ access_key: WEB3_KEY, subject: 'Новая заявка КП — ' + (L.contact.name || ''), from_name: 'parametrica.kz', email: L.contact.email, message: text.replace(/<[^>]+>/g, '') })
  }).then(r => r.json()).catch(e => ({ mail_error: String(e) })));
  try { const r = await Promise.all(tasks); console.log('lead ok', r); res.json({ ok: true, sent: r.length }); }
  catch (e) { console.error('lead error', e); res.json({ ok: true, warn: String(e) }); }  // клиента не валим
});

// ===== АВТО-ОБНОВЛЕНИЕ ЦЕН (инструмент price-admin.html) =====
// env на Render: ADMIN_PWD (пароль тула), SHOPIFY_STORE (parametrica-store.myshopify.com),
//               SHOPIFY_ADMIN_TOKEN (Admin API токен кастомного приложения), [WIX_API_KEY, WIX_SITE_ID]
const ADMIN_PWD   = process.env.ADMIN_PWD || '';
const SHOP        = process.env.SHOPIFY_STORE || '';
const SHOP_TOKEN  = process.env.SHOPIFY_ADMIN_TOKEN || '';
const SHOP_API    = process.env.SHOPIFY_API_VERSION || '2026-01';
function nrmArt(s){ return String(s == null ? '' : s).toLowerCase().replace(/[^a-z0-9]/g, ''); }
async function shopifyGQL(query, variables){
  const r = await fetch('https://' + SHOP + '/admin/api/' + SHOP_API + '/graphql.json', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': SHOP_TOKEN },
    body: JSON.stringify({ query, variables })
  });
  return r.json();
}
app.post('/admin/apply-prices', async (req, res) => {
  const B = req.body || {};
  if (!ADMIN_PWD || B.pwd !== ADMIN_PWD) return res.status(401).json({ error: 'unauthorized' });
  const changes = Array.isArray(B.changes) ? B.changes : [];
  if (!changes.length) return res.json({ shopify: 'нет изменений', wix: '—' });

  // — Shopify: цена варианта = интерьерная; товар ищем по названию Bench "<артикул>"
  let shopify = 'пропущен (нет токена)';
  let diag = null;   // ДИАГНОСТИКА: первый реальный ответ/ошибка Shopify (за паролём, безопасно)
  if (SHOP && SHOP_TOKEN) {
    let ok = 0, fail = 0, miss = 0;
    for (const ch of changes) {
      if (ch.interior == null) continue;
      try {
        const q = '{ products(first:5, query:' + JSON.stringify(String(ch.article)) +
                  '){edges{node{id title variants(first:1){edges{node{id}}}}}}}';
        const j = await shopifyGQL(q);
        if (diag === null) diag = { stage: 'search', errors: j.errors || null, found: ((((j.data || {}).products || {}).edges) || []).length, apiVersion: SHOP_API };
        const edges = (((j.data || {}).products || {}).edges) || [];
        const want = nrmArt(ch.article);
        let node = null;
        for (const e of edges) { if (nrmArt(e.node.title).indexOf(want) >= 0) { node = e.node; break; } }
        if (!node || !node.variants.edges.length) { miss++; continue; }
        const vid = node.variants.edges[0].node.id;
        const m = 'mutation($p:ID!,$v:[ProductVariantsBulkInput!]!){productVariantsBulkUpdate(productId:$p,variants:$v){userErrors{message}}}';
        const mj = await shopifyGQL(m, { p: node.id, v: [{ id: vid, price: String(ch.interior) }] });
        const errs = (((mj.data || {}).productVariantsBulkUpdate || {}).userErrors) || [];
        diag = { stage: 'update', errors: mj.errors || null, userErrors: errs, apiVersion: SHOP_API };
        if (errs.length) { fail++; } else { ok++; }
      } catch (e) { fail++; if (diag === null) diag = { stage: 'exception', message: String(e && e.message || e) }; }
    }
    shopify = 'обновлено ' + ok + (fail ? (', ошибок ' + fail) : '') + (miss ? (', не найдено ' + miss) : '');
  }

  // — Wix Stores: требует подтверждённого Catalog API (site ' + (process.env.WIX_SITE_ID||'') + ')
  let wix = process.env.WIX_API_KEY ? 'нужно подключить Stores Catalog API' : 'пропущен (нет ключа)';

  res.json({ shopify, wix, diag, note: 'products.json/prices.json обновляются заменой файла в репозитории' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('KP PDF server listening on ' + PORT));
