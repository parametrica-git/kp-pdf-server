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
//   ВАРИАНТ 1 (Dev Dashboard, рекомендуется): SHOPIFY_CLIENT_ID + SHOPIFY_CLIENT_SECRET (со страницы Credentials)
//   ВАРИАНТ 2 (старый): SHOPIFY_ADMIN_TOKEN (статичный Admin API токен). [WIX_API_KEY, WIX_SITE_ID]
const ADMIN_PWD   = process.env.ADMIN_PWD || '';
const SHOP        = process.env.SHOPIFY_STORE || '';
const SHOP_TOKEN  = process.env.SHOPIFY_ADMIN_TOKEN || '';
const SHOP_CID    = process.env.SHOPIFY_CLIENT_ID || '';
const SHOP_SECRET = process.env.SHOPIFY_CLIENT_SECRET || '';
const SHOP_API    = process.env.SHOPIFY_API_VERSION || '2026-01';
const WIX_KEY     = process.env.WIX_API_KEY || '';      // Wix: API-ключ (manage.wix.com/account/api-keys)
const WIX_SITE    = process.env.WIX_SITE_ID || '';      // Wix: site id (de4f9737-...)
const GH_TOKEN    = process.env.GITHUB_TOKEN || '';     // GitHub PAT (Contents: write) — сохранять живой products.json
const GH_REPO     = process.env.GITHUB_REPO || 'parametrica-git/kp-pdf-server';
const GH_PATH     = process.env.GITHUB_PRODUCTS_PATH || 'products.json';
const GH_BRANCH   = process.env.GITHUB_BRANCH || 'main';
function nrmArt(s){ return String(s == null ? '' : s).toLowerCase().replace(/[^a-z0-9]/g, ''); }
// Токен Admin API: при наличии Client ID+Secret меняем их на токен (client credentials grant —
// для приложения Dev Dashboard на своём магазине; токен живёт ~24ч, кэшируем). Иначе — статичный токен.
let _tok = null, _tokExp = 0;
async function getShopToken(){
  if (_tok && Date.now() < _tokExp - 60000) return _tok;
  if (SHOP_CID && SHOP_SECRET) {
    const r = await fetch('https://' + SHOP + '/admin/oauth/access_token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'client_credentials', client_id: SHOP_CID, client_secret: SHOP_SECRET })
    });
    const j = await r.json().catch(function(){ return {}; });
    if (!r.ok || !j.access_token) throw new Error('token exchange ' + r.status + ': ' + JSON.stringify(j).slice(0, 200));
    _tok = j.access_token; _tokExp = Date.now() + ((j.expires_in || 86399) * 1000);
    return _tok;
  }
  return SHOP_TOKEN;
}
async function shopifyGQL(query, variables){
  const tok = await getShopToken();
  const r = await fetch('https://' + SHOP + '/admin/api/' + SHOP_API + '/graphql.json', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': tok },
    body: JSON.stringify({ query, variables })
  });
  return r.json();
}
// ── Wix Stores (Catalog V1): авторизация API-ключом; товар по названию Bench "<арт>"; обновление цены ──
function wixHeaders(){ return { 'Authorization': WIX_KEY, 'wix-site-id': WIX_SITE, 'Content-Type': 'application/json' }; }
let _wixMap = null;   // nrmArt(name) -> productId
async function wixLoadProducts(){
  if (_wixMap) return _wixMap;
  const m = {}; let offset = 0;
  for (let page = 0; page < 6; page++) {
    const r = await fetch('https://www.wixapis.com/stores/v1/products/query', {
      method: 'POST', headers: wixHeaders(),
      body: JSON.stringify({ query: { paging: { limit: 100, offset: offset } } })
    });
    const j = await r.json().catch(function(){ return {}; });
    if (!r.ok) throw new Error('query ' + r.status + ': ' + JSON.stringify(j).slice(0, 150));
    const prods = j.products || [];
    for (let i = 0; i < prods.length; i++) m[nrmArt(prods[i].name)] = prods[i].id;
    if (prods.length < 100) break;
    offset += 100;
  }
  _wixMap = m; return m;
}
async function wixSetPrice(productId, price){
  const r = await fetch('https://www.wixapis.com/stores/v1/products/' + productId, {
    method: 'PATCH', headers: wixHeaders(),
    body: JSON.stringify({ product: { priceData: { price: Number(price) } } })
  });
  const j = await r.json().catch(function(){ return {}; });
  return { ok: r.ok, status: r.status, err: (j && (j.message || j.error)) || null };
}
// ── GitHub: сохранить актуальный products.json в репозиторий (живой источник цен для КП/инвойс/сайта) ──
async function commitFileToGitHub(contentObj){
  const api = 'https://api.github.com/repos/' + GH_REPO + '/contents/' + GH_PATH;
  const hdr = { 'Authorization': 'Bearer ' + GH_TOKEN, 'Accept': 'application/vnd.github+json', 'User-Agent': 'kp-pdf-server', 'Content-Type': 'application/json' };
  let sha = null;
  const g = await fetch(api + '?ref=' + GH_BRANCH, { headers: hdr });
  if (g.ok) { const gj = await g.json().catch(function(){ return {}; }); sha = gj.sha || null; }
  const content = Buffer.from(JSON.stringify(contentObj, null, 2), 'utf8').toString('base64');
  const body = { message: 'price update', content: content, branch: GH_BRANCH };
  if (sha) body.sha = sha;
  const p = await fetch(api, { method: 'PUT', headers: hdr, body: JSON.stringify(body) });
  const pj = await p.json().catch(function(){ return {}; });
  if (!p.ok) throw new Error('github ' + p.status + ': ' + JSON.stringify(pj).slice(0, 150));
  return { commit: (pj.commit && pj.commit.sha) ? pj.commit.sha.slice(0, 7) : 'ok' };
}
app.post('/admin/apply-prices', async (req, res) => {
  const B = req.body || {};
  if (!ADMIN_PWD || B.pwd !== ADMIN_PWD) return res.status(401).json({ error: 'unauthorized' });
  const changes = Array.isArray(B.changes) ? B.changes : [];
  if (!changes.length) return res.json({ shopify: 'нет изменений', wix: '—' });

  // — Shopify: цена варианта = интерьерная; товар ищем по названию Bench "<артикул>"
  let shopify = 'пропущен (нет токена)';
  let diag = null;   // ДИАГНОСТИКА: первый реальный ответ/ошибка Shopify (за паролём, безопасно)
  if (SHOP && (SHOP_TOKEN || (SHOP_CID && SHOP_SECRET))) {
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

  // — Wix Stores (Catalog V1): цена = интерьерная; товар по названию Bench "<артикул>"
  let wix = 'пропущен (нет ключа)';
  let wdiag = null;
  if (WIX_KEY && WIX_SITE) {
    try {
      const map = await wixLoadProducts();
      let ok = 0, fail = 0, miss = 0;
      for (const ch of changes) {
        if (ch.interior == null) continue;
        const id = map['bench' + nrmArt(ch.article)];
        if (!id) { miss++; continue; }
        const res2 = await wixSetPrice(id, ch.interior);
        if (wdiag === null) wdiag = res2;
        if (res2.ok) ok++; else fail++;
      }
      wix = 'обновлено ' + ok + (fail ? (', ошибок ' + fail) : '') + (miss ? (', не найдено ' + miss) : '');
    } catch (e) { wix = 'ошибка: ' + String(e && e.message || e).slice(0, 150); }
  }

  // — Живой products.json в GitHub: его читают КП/инвойс/сайт вживую (без пересборки и без меня)
  let pricesFile = 'пропущен (нет productsJson или GITHUB_TOKEN)';
  if (B.productsJson && GH_TOKEN) {
    try { const r = await commitFileToGitHub(B.productsJson); pricesFile = 'сохранён (' + r.commit + ')'; }
    catch (e) { pricesFile = 'ошибка: ' + String(e && e.message || e).slice(0, 150); }
  }

  res.json({ shopify, wix, pricesFile, diag, wdiag, note: 'Shopify/Wix обновлены пушем; products.json сохранён в GitHub (живой источник для КП/инвойс/сайта)' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('KP PDF server listening on ' + PORT));
