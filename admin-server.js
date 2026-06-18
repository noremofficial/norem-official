#!/usr/bin/env node
/**
 * NOREM 管理サーバー
 * 起動: node admin-server.js
 * URL : http://localhost:3001
 */
const http   = require('http');
const https  = require('https');
const fs     = require('fs');
const path   = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });
const vm     = require('vm');
const { execSync } = require('child_process');

// ── 決済・メール設定（.env から読み込み）──────────────
const CFG = {
  stripe:    { secret: process.env.STRIPE_SECRET_KEY      || '', pub: process.env.STRIPE_PUBLISHABLE_KEY  || '', webhook: process.env.STRIPE_WEBHOOK_SECRET || '' },
  paypay:    { key: process.env.PAYPAY_API_KEY             || '', secret: process.env.PAYPAY_API_SECRET    || '', merchant: process.env.PAYPAY_MERCHANT_ID   || '', env: process.env.PAYPAY_ENV || 'staging' },
  paypal:    { clientId: process.env.PAYPAL_CLIENT_ID      || '', secret: process.env.PAYPAL_CLIENT_SECRET || '', env: process.env.PAYPAL_ENV || 'sandbox' },
  amazonPay: { pubKeyId: process.env.AMAZON_PAY_PUBLIC_KEY_ID || '', privKey: process.env.AMAZON_PAY_PRIVATE_KEY || '', merchant: process.env.AMAZON_PAY_MERCHANT_ID || '', store: process.env.AMAZON_PAY_STORE_ID || '', region: process.env.AMAZON_PAY_REGION || 'jp' },
  mail:      { from: process.env.MAIL_FROM || '', pass: process.env.MAIL_PASS || '', admin: process.env.MAIL_ADMIN || process.env.MAIL_FROM || '' },
  siteUrl:   process.env.SITE_URL || 'http://localhost:8765',
};

// Stripe（キー設定済みのときのみ初期化）
let stripe = null;
if (CFG.stripe.secret && !CFG.stripe.secret.includes('ここに')) {
  try { stripe = require('stripe')(CFG.stripe.secret); } catch(e) {}
}

// Nodemailer（Gmail SMTP）
let nodemailer = null;
let mailTransport = null;
try {
  nodemailer = require('nodemailer');
  const mailReady = CFG.mail.from && CFG.mail.from.includes('@') && !CFG.mail.from.includes('あなたの') && CFG.mail.pass && CFG.mail.pass.length >= 16 && !CFG.mail.pass.includes('ここに');
  if (mailReady) {
    mailTransport = nodemailer.createTransport({
      service: 'gmail',
      auth: { user: CFG.mail.from, pass: CFG.mail.pass },
    });
  }
} catch(e) {}

// ── LINE Login 設定 ──────────────────────────────────
const pendingLineSessions = new Map(); // token → profile data (5分で失効)

const LINE_CHANNEL_ID     = '2010314175';
const LINE_CHANNEL_SECRET = '3fa4dfbe1dacb5fa0f57fedb7bed5a2d';
// ↓ Supabase Dashboard → Settings → API → service_role キーを貼り付けてください
const SUPABASE_SERVICE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InV1aG1yemt1eXF4aHhmemRsbXNqIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc4MDY1MTIzMCwiZXhwIjoyMDk2MjI3MjMwfQ.GRyIgbxlbCGdvratRebDZFmgtJ7qCkJGQyf4yyqHdJQ';
const SUPABASE_URL         = 'https://uuhmrzkuyqxhxfzdlmsj.supabase.co';
const SITE_ORIGIN          = 'http://localhost:8765';

function httpsPost(hostname, path, headers, body, method = 'POST') {
  return new Promise((resolve, reject) => {
    const data = typeof body === 'string' ? body : JSON.stringify(body);
    const req = https.request({ hostname, path, method, headers }, res => {
      let raw = '';
      res.on('data', c => raw += c);
      res.on('end', () => {
        try { resolve(JSON.parse(raw)); } catch { resolve(raw); }
      });
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

function httpsGet(hostname, path, headers) {
  return new Promise((resolve, reject) => {
    const req = https.request({ hostname, path, method: 'GET', headers }, res => {
      let raw = '';
      res.on('data', c => raw += c);
      res.on('end', () => {
        try { resolve(JSON.parse(raw)); } catch { resolve(raw); }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

const PORT = 3001;
const DIR  = __dirname;

function loadProductsData() {
  try {
    const code = fs.readFileSync(path.join(DIR, 'products-data.js'), 'utf8');
    const match = code.match(/const PRODUCTS_DATA\s*=\s*(\[[\s\S]*?\]);/);
    if (!match) return [];
    return JSON.parse(match[1]);
  } catch(e) { console.error('loadProductsData error:', e.message); return []; }
}

function loadAdminData() {
  const p = path.join(DIR, 'admin-data.json');
  if (!fs.existsSync(p)) return {};
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch(e) { return {}; }
}

function saveAdminData(data) {
  fs.writeFileSync(path.join(DIR, 'admin-data.json'), JSON.stringify(data, null, 2), 'utf8');
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  const cors = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };

  if (req.method === 'OPTIONS') { res.writeHead(204, cors); res.end(); return; }

  // ── LINE OAuth コールバック ──────────────────────────
  if (url.pathname === '/api/line-callback' && req.method === 'GET') {
    const code  = url.searchParams.get('code');
    const error = url.searchParams.get('error');

    if (error || !code) {
      res.writeHead(302, { ...cors, Location: `${SITE_ORIGIN}/signup.html?line_error=cancelled` });
      res.end(); return;
    }

    try {
      // 1. LINEアクセストークン取得
      const tokenBody = new URLSearchParams({
        grant_type: 'authorization_code', code,
        redirect_uri:  'http://localhost:3001/api/line-callback',
        client_id:     LINE_CHANNEL_ID,
        client_secret: LINE_CHANNEL_SECRET,
      }).toString();

      const tokenRes = await httpsPost('api.line.me', '/oauth2/v2.1/token',
        { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(tokenBody) },
        tokenBody
      );

      if (!tokenRes.access_token) {
        res.writeHead(302, { ...cors, Location: `${SITE_ORIGIN}/signup.html?line_error=token` });
        res.end(); return;
      }

      // 2. LINEプロフィール取得
      const profile = await httpsGet('api.line.me', '/v2/profile',
        { Authorization: `Bearer ${tokenRes.access_token}` }
      );
      console.log('[LINE] profile:', profile.displayName, profile.userId);

      const lineUserId     = profile.userId;
      const displayName    = profile.displayName || '';
      const pictureUrl     = profile.pictureUrl  || '';
      const syntheticEmail = `line_${lineUserId.toLowerCase()}@norem.line`;
      // チャネルに依存しない固定ソルトでパスワードを生成
      const syntheticPass  = require('crypto')
        .createHmac('sha256', 'norem-line-fixed-salt').update(lineUserId).digest('hex');

      // 3. サインイン試行
      let signInRes = await httpsPost(
        'uuhmrzkuyqxhxfzdlmsj.supabase.co',
        '/auth/v1/token?grant_type=password',
        { 'Content-Type': 'application/json', apikey: SUPABASE_SERVICE_KEY },
        { email: syntheticEmail, password: syntheticPass }
      );

      if (!signInRes.access_token) {
        // ユーザー一覧から該当ユーザーを検索
        const listRes = await httpsGet(
          'uuhmrzkuyqxhxfzdlmsj.supabase.co',
          `/auth/v1/admin/users?page=1&per_page=1000`,
          { Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`, apikey: SUPABASE_SERVICE_KEY }
        );
        const existing = listRes.users?.find(u => u.email?.toLowerCase() === syntheticEmail.toLowerCase());

        if (existing?.id) {
          // 既存ユーザー → パスワードを新しいソルトで更新
          await httpsPost(
            'uuhmrzkuyqxhxfzdlmsj.supabase.co',
            `/auth/v1/admin/users/${existing.id}`,
            { Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`, apikey: SUPABASE_SERVICE_KEY, 'Content-Type': 'application/json' },
            { password: syntheticPass },
            'PUT'
          );
          console.log('[Supabase] password updated for existing user');
        } else {
          // 新規ユーザー作成
          await httpsPost(
            'uuhmrzkuyqxhxfzdlmsj.supabase.co',
            '/auth/v1/admin/users',
            { Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`, apikey: SUPABASE_SERVICE_KEY, 'Content-Type': 'application/json' },
            { email: syntheticEmail, password: syntheticPass, email_confirm: true,
              user_metadata: { full_name: displayName, avatar_url: pictureUrl, line_user_id: lineUserId } }
          );
          console.log('[Supabase] new user created');
        }

        // 再サインイン
        signInRes = await httpsPost(
          'uuhmrzkuyqxhxfzdlmsj.supabase.co',
          '/auth/v1/token?grant_type=password',
          { 'Content-Type': 'application/json', apikey: SUPABASE_SERVICE_KEY },
          { email: syntheticEmail, password: syntheticPass }
        );
      }
      console.log('[Supabase] signIn:', signInRes.access_token ? 'OK' : JSON.stringify(signInRes).slice(0,200));

      if (!signInRes.access_token) {
        res.writeHead(302, { ...cors, Location: `${SITE_ORIGIN}/cart.html?line_error=session` });
        res.end(); return;
      }

      // profilesテーブルにLINE表示名を保存（初回のみ上書きしない）
      if (signInRes.user?.id) {
        await httpsPost(
          'uuhmrzkuyqxhxfzdlmsj.supabase.co',
          '/rest/v1/profiles',
          { Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`, apikey: SUPABASE_SERVICE_KEY,
            'Content-Type': 'application/json', Prefer: 'resolution=ignore-duplicates,return=minimal' },
          { id: signInRes.user.id, email: syntheticEmail, full_name: displayName }
        );
      }

      // 4. セッションをURLフラグメントでカートへ渡す
      const dest = `${SITE_ORIGIN}/cart.html#access_token=${signInRes.access_token}&refresh_token=${signInRes.refresh_token}`;
      res.writeHead(302, { ...cors, Location: dest });
      res.end();
    } catch (e) {
      console.error('LINE callback error:', e);
      res.writeHead(302, { ...cors, Location: `${SITE_ORIGIN}/signup.html?line_error=server` });
      res.end();
    }
    return;
  }

  if (url.pathname === '/' || url.pathname === '/admin.html') {
    const html = fs.readFileSync(path.join(DIR, 'admin.html'), 'utf8');
    res.writeHead(200, { ...cors, 'Content-Type': 'text/html; charset=utf-8' });
    res.end(html);
    return;
  }

  if (url.pathname === '/api/data' && req.method === 'GET') {
    const products  = loadProductsData();
    const adminData = loadAdminData();

    // collections-data.js を解析して返す
    let collections = [];
    try {
      const code = fs.readFileSync(path.join(DIR, 'collections-data.js'), 'utf8');
      collections = (new Function(code + '; return COLLECTIONS_DATA;'))();
    } catch(e) {}

    // news-data.js（ビルド済み）は参照用のみ — adminのソースはadminData.newArticles
    let news = [];
    try {
      const code = fs.readFileSync(path.join(DIR, 'news-data.js'), 'utf8');
      news = (new Function(code + '; return NEWS_DATA;'))();
    } catch(e) {}

    // products/ ディレクトリのサブフォルダ一覧（空シーズンも含む）
    let productSeasons = [];
    try {
      const productsDir = path.join(DIR, 'products');
      productSeasons = fs.readdirSync(productsDir).filter(d => {
        try { return fs.statSync(path.join(productsDir, d)).isDirectory(); } catch(e) { return false; }
      });
    } catch(e) {}

    res.writeHead(200, { ...cors, 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ products, adminData, collections, news, newsSource: [], productSeasons }));
    return;
  }

  // ── 新シーズン作成 API ─────────────────────────────
  if (url.pathname === '/api/create-season' && req.method === 'POST') {
    let body = '';
    req.on('data', d => body += d);
    req.on('end', () => {
      try {
        const { season } = JSON.parse(body);
        if (!season || !/^[a-zA-Z0-9\-\_\.]+$/.test(season)) {
          res.writeHead(400, { ...cors, 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: 'シーズン名に使えない文字が含まれています' }));
          return;
        }
        const dir = path.join(DIR, 'products', season);
        fs.mkdirSync(dir, { recursive: true });
        execSync('node build.js', { cwd: DIR, stdio: 'pipe' });
        res.writeHead(200, { ...cors, 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, season }));
      } catch(e) {
        res.writeHead(500, { ...cors, 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: e.message }));
      }
    });
    return;
  }

  if (url.pathname === '/api/save' && req.method === 'POST') {
    let body = '';
    req.on('data', d => body += d);
    req.on('end', () => {
      try {
        saveAdminData(JSON.parse(body));
        execSync('node build.js', { cwd: DIR, stdio: 'pipe' });
        res.writeHead(200, { ...cors, 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      } catch(e) {
        res.writeHead(500, { ...cors, 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: e.message }));
      }
    });
    return;
  }

  // ── 画像削除 API ─────────────────────────────
  if (url.pathname === '/api/delete-file' && req.method === 'POST') {
    let body = '';
    req.on('data', d => body += d);
    req.on('end', () => {
      try {
        const { filePath } = JSON.parse(body);
        const safePath = filePath.replace(/\.\./g, '').replace(/^\/+/, '');
        const fullPath = path.join(DIR, safePath);
        if (!fullPath.startsWith(DIR)) {
          res.writeHead(400, { ...cors, 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: 'Invalid path' }));
          return;
        }
        if (fs.existsSync(fullPath)) fs.unlinkSync(fullPath);
        execSync('node build.js', { cwd: DIR, stdio: 'pipe' });
        res.writeHead(200, { ...cors, 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      } catch(e) {
        res.writeHead(500, { ...cors, 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: e.message }));
      }
    });
    return;
  }

  // ── 画像アップロード API ─────────────────────────────
  if (url.pathname === '/api/upload' && req.method === 'POST') {
    let body = '';
    req.on('data', d => body += d);
    req.on('end', () => {
      try {
        const { path: filePath, filename, base64, mimeType } = JSON.parse(body);
        if (!filePath || !filename || !base64) {
          res.writeHead(400, { ...cors, 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: 'path, filename, base64 required' }));
          return;
        }
        // Sanitize path components
        const safePath     = filePath.replace(/\.\./g, '').replace(/^\/+/, '');
        const safeFilename = filename.replace(/\.\./g, '').replace(/[/\\]/g, '');
        const destDir  = path.join(DIR, safePath);
        const destFile = path.join(destDir, safeFilename);
        fs.mkdirSync(destDir, { recursive: true });
        const buf = Buffer.from(base64, 'base64');
        fs.writeFileSync(destFile, buf);
        const urlPath = '/' + safePath.replace(/\\/g, '/') + '/' + safeFilename;
        res.writeHead(200, { ...cors, 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, url: urlPath }));
      } catch(e) {
        res.writeHead(500, { ...cors, 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: e.message }));
      }
    });
    return;
  }

  // ── HOME スライダー再構築 API ──────────────────────────
  if (url.pathname === '/api/rebuild-home' && req.method === 'POST') {
    let body = '';
    req.on('data', d => body += d);
    req.on('end', () => {
      try {
        const payload = JSON.parse(body || '{}');
        // 新フォーマット: { images: [{src, link}] }  旧: { links: {src: link} }
        let homeImages = [];
        if (Array.isArray(payload.images)) {
          homeImages = payload.images.filter(img => img.src && img.link);
        } else if (payload.links) {
          const homeDir = path.join(DIR, 'home');
          const IMG_RE = /\.(png|jpg|jpeg|webp|gif)$/i;
          if (fs.existsSync(homeDir)) {
            homeImages = fs.readdirSync(homeDir).filter(f => IMG_RE.test(f)).sort()
              .map(f => ({ src: `home/${f}`, link: payload.links[`home/${f}`] || 'collection.html' }));
          }
        }
        const out = `// AUTO-GENERATED — node build.js を実行すると更新されます\nconst HOME_IMAGES = ${JSON.stringify(homeImages, null, 2)};\n`;
        fs.writeFileSync(path.join(DIR, 'home-data.js'), out, 'utf8');
        res.writeHead(200, { ...cors, 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, count: homeImages.length }));
      } catch(e) {
        res.writeHead(500, { ...cors, 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: e.message }));
      }
    });
    return;
  }

  // ── HOME 画像削除 API ────────────────────────────────
  if (url.pathname === '/api/delete-home-image' && req.method === 'POST') {
    let body = '';
    req.on('data', d => body += d);
    req.on('end', () => {
      try {
        const { filename } = JSON.parse(body);
        const safe = filename.replace(/\.\./g, '').replace(/[/\\]/g, '');
        const fp = path.join(DIR, 'home', safe);
        if (fs.existsSync(fp)) fs.unlinkSync(fp);
        res.writeHead(200, { ...cors, 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      } catch(e) {
        res.writeHead(500, { ...cors, 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: e.message }));
      }
    });
    return;
  }

  // ── ファイル一覧 API ─────────────────────────────────
  if (url.pathname === '/api/files' && req.method === 'GET') {
    const dir = url.searchParams.get('dir') || '';
    try {
      const safeDir  = dir.replace(/\.\./g, '').replace(/^\/+/, '');
      const fullPath = path.join(DIR, safeDir);
      if (!fs.existsSync(fullPath)) {
        res.writeHead(200, { ...cors, 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, files: [] }));
        return;
      }
      const IMG_EXT = /\.(png|jpg|jpeg|webp|gif|PNG|JPG|JPEG|WEBP|GIF)$/;
      const files = fs.readdirSync(fullPath)
        .filter(f => IMG_EXT.test(f))
        .map(f => ({
          filename: f,
          url: '/' + safeDir.replace(/\\/g, '/') + '/' + f,
        }));
      res.writeHead(200, { ...cors, 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, files }));
    } catch(e) {
      res.writeHead(500, { ...cors, 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: e.message }));
    }
    return;
  }

  // ══════════════════════════════════════════════════════
  //  決済 API
  // ══════════════════════════════════════════════════════

  // ── Stripe: PaymentIntent 作成 ─────────────────────
  if (url.pathname === '/api/payment/stripe/create-intent' && req.method === 'POST') {
    let body = '';
    req.on('data', d => body += d);
    req.on('end', async () => {
      if (!stripe) {
        res.writeHead(503, { ...cors, 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ ok: false, error: 'Stripe未設定。.envにSTRIPE_SECRET_KEYを入力してください' }));
      }
      try {
        const { amount, currency = 'jpy', metadata = {} } = JSON.parse(body);
        const intent = await stripe.paymentIntents.create({
          amount: Math.round(amount),
          currency,
          metadata,
          automatic_payment_methods: { enabled: true },
        });
        res.writeHead(200, { ...cors, 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, clientSecret: intent.client_secret, intentId: intent.id }));
      } catch(e) {
        res.writeHead(500, { ...cors, 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: e.message }));
      }
    });
    return;
  }

  // ── Stripe: Webhook ────────────────────────────────
  if (url.pathname === '/api/payment/stripe/webhook' && req.method === 'POST') {
    const chunks = [];
    req.on('data', d => chunks.push(d));
    req.on('end', () => {
      try {
        const raw = Buffer.concat(chunks);
        let event;
        if (stripe && CFG.stripe.webhook && !CFG.stripe.webhook.includes('ここに')) {
          event = stripe.webhooks.constructEvent(raw, req.headers['stripe-signature'], CFG.stripe.webhook);
        } else {
          event = JSON.parse(raw.toString());
        }
        if (event.type === 'payment_intent.succeeded') {
          const intent = event.data.object;
          console.log('✅ Stripe 決済完了:', intent.id, intent.amount, intent.currency);
          // メール送信はフロントエンドの /api/order/send-mail で行う
        }
        res.writeHead(200, { ...cors, 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ received: true }));
      } catch(e) {
        res.writeHead(400, cors);
        res.end('Webhook error: ' + e.message);
      }
    });
    return;
  }

  // ── PayPay: 決済URL作成 ────────────────────────────
  if (url.pathname === '/api/payment/paypay/create' && req.method === 'POST') {
    let body = '';
    req.on('data', d => body += d);
    req.on('end', async () => {
      if (!CFG.paypay.key || CFG.paypay.key.includes('ここに')) {
        res.writeHead(503, { ...cors, 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ ok: false, error: 'PayPay未設定。.envにPAYPAY_API_KEYを入力してください' }));
      }
      try {
        const { amount, orderId, orderDescription } = JSON.parse(body);
        const merchant = CFG.paypay.merchant;
        const apiBase  = CFG.paypay.env === 'staging'
          ? 'https://stg-api.paypay.ne.jp'
          : 'https://api.paypay.ne.jp';
        const payload = {
          merchantPaymentId: orderId,
          amount: { amount, currency: 'JPY' },
          orderDescription: orderDescription || 'NOREM Order',
          codeType: 'ORDER_QR',
          redirectUrl:    CFG.siteUrl + '/cart.html?payment=paypay_complete',
          redirectType:   'WEB_LINK',
          requestedAt:    Math.floor(Date.now() / 1000),
        };
        // HMAC-SHA256 署名生成
        const crypto = require('crypto');
        const epoch  = Math.floor(Date.now() / 1000);
        const nonce  = Math.random().toString(36).slice(2);
        const bodyStr = JSON.stringify(payload);
        const hashedBody = crypto.createHash('sha256').update(bodyStr).digest('base64');
        const message    = [apiBase.replace('https://', ''), '/v1/codes', epoch, nonce, 'POST', hashedBody].join('\n');
        const hmac       = crypto.createHmac('sha256', CFG.paypay.secret).update(message).digest('base64');
        const authHeader = `hmac OPA-Auth:${CFG.paypay.key}:${nonce}:${epoch}:${hashedBody}:${hmac}`;
        const ppRes = await httpsPost(
          apiBase.replace('https://', ''),
          '/v1/codes',
          { 'Content-Type': 'application/json', 'Authorization': authHeader, 'X-API-KEY': CFG.paypay.key, 'X-MERCHANT-ID': merchant },
          bodyStr
        );
        const ppData = JSON.parse(ppRes);
        if (ppData.resultInfo?.code === 'SUCCESS') {
          res.writeHead(200, { ...cors, 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, redirectUrl: ppData.data?.url, deeplink: ppData.data?.deeplink }));
        } else {
          res.writeHead(500, { ...cors, 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: ppData.resultInfo?.message || 'PayPay error' }));
        }
      } catch(e) {
        res.writeHead(500, { ...cors, 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: e.message }));
      }
    });
    return;
  }

  // ── PayPal: アクセストークン取得 ──────────────────
  async function getPaypalToken() {
    const base = CFG.paypal.env === 'live' ? 'api.paypal.com' : 'api.sandbox.paypal.com';
    const creds = Buffer.from(`${CFG.paypal.clientId}:${CFG.paypal.secret}`).toString('base64');
    const raw = await httpsPost(base, '/v1/oauth2/token',
      { 'Content-Type': 'application/x-www-form-urlencoded', 'Authorization': `Basic ${creds}` },
      'grant_type=client_credentials'
    );
    return raw.access_token;
  }

  // ── PayPal: オーダー作成 ───────────────────────────
  if (url.pathname === '/api/payment/paypal/create-order' && req.method === 'POST') {
    let body = '';
    req.on('data', d => body += d);
    req.on('end', async () => {
      if (!CFG.paypal.clientId || CFG.paypal.clientId.includes('ここに')) {
        res.writeHead(503, { ...cors, 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ ok: false, error: 'PayPal未設定。.envにPAYPAL_CLIENT_IDを入力してください' }));
      }
      try {
        const { amount } = JSON.parse(body);
        const token   = await getPaypalToken();
        const base    = CFG.paypal.env === 'live' ? 'api.paypal.com' : 'api.sandbox.paypal.com';
        const order = await httpsPost(base, '/v2/checkout/orders',
          { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
          JSON.stringify({ intent: 'CAPTURE', purchase_units: [{ amount: { currency_code: 'JPY', value: String(amount) } }] })
        );
        res.writeHead(200, { ...cors, 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, orderId: order.id }));
      } catch(e) {
        res.writeHead(500, { ...cors, 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: e.message }));
      }
    });
    return;
  }

  // ── PayPal: オーダーキャプチャ ─────────────────────
  if (url.pathname === '/api/payment/paypal/capture' && req.method === 'POST') {
    let body = '';
    req.on('data', d => body += d);
    req.on('end', async () => {
      try {
        const { orderId } = JSON.parse(body);
        const token  = await getPaypalToken();
        const base   = CFG.paypal.env === 'live' ? 'api.paypal.com' : 'api.sandbox.paypal.com';
        const result = await httpsPost(base, `/v2/checkout/orders/${orderId}/capture`,
          { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
          '{}'
        );
        res.writeHead(200, { ...cors, 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: result.status === 'COMPLETED', status: result.status, data: result }));
      } catch(e) {
        res.writeHead(500, { ...cors, 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: e.message }));
      }
    });
    return;
  }

  // ── Amazon Pay: チェックアウトセッション作成 ──────
  if (url.pathname === '/api/payment/amazon/create-session' && req.method === 'POST') {
    let body = '';
    req.on('data', d => body += d);
    req.on('end', async () => {
      if (!CFG.amazonPay.merchant || CFG.amazonPay.merchant.includes('ここに')) {
        res.writeHead(503, { ...cors, 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ ok: false, error: 'Amazon Pay未設定。.envにAMAZON_PAY_MERCHANT_IDを入力してください' }));
      }
      try {
        const { amount, orderId } = JSON.parse(body);
        // Amazon Pay v2 Checkout Session
        const payload = {
          webCheckoutDetails: {
            checkoutReviewReturnUrl: CFG.siteUrl + '/cart.html?payment=amazon_review',
            checkoutResultReturnUrl: CFG.siteUrl + '/cart.html?payment=amazon_complete',
          },
          storeId: CFG.amazonPay.store,
          chargeAmount: { amount: String(amount), currencyCode: 'JPY' },
        };
        const apiRegion = { jp: 'pay-api.amazon.jp', us: 'pay-api.amazon.com', eu: 'pay-api.amazon.eu' }[CFG.amazonPay.region] || 'pay-api.amazon.jp';
        const crypto   = require('crypto');
        const bodyStr  = JSON.stringify(payload);
        const timestamp = new Date().toISOString().replace(/\..+/, 'Z');
        const hashedBody = crypto.createHash('sha256').update(bodyStr).digest('hex');
        const signedHeaders = 'content-type;x-amz-pay-date;x-amz-pay-host;x-amz-pay-region';
        const canonicalRequest = [
          'POST', '/v2/checkoutSessions', '',
          `content-type:application/json\nx-amz-pay-date:${timestamp}\nx-amz-pay-host:${apiRegion}\nx-amz-pay-region:${CFG.amazonPay.region}`,
          '', signedHeaders, hashedBody
        ].join('\n');
        const stringToSign = `AMZN-PAY-RSASSA-PSS\n${timestamp}\n` +
          crypto.createHash('sha256').update(canonicalRequest).digest('hex');
        const privKeyPem = CFG.amazonPay.privKey.includes('-----') ? CFG.amazonPay.privKey : `-----BEGIN RSA PRIVATE KEY-----\n${CFG.amazonPay.privKey}\n-----END RSA PRIVATE KEY-----`;
        const signature = crypto.sign('sha256', Buffer.from(stringToSign), { key: privKeyPem, padding: crypto.constants.RSA_PKCS1_PSS_PADDING });
        const authHeader = `AMZN-PAY-RSASSA-PSS PublicKeyId=${CFG.amazonPay.pubKeyId},SignedHeaders=${signedHeaders},Signature=${signature.toString('base64')}`;
        const apRes = await httpsPost(apiRegion, '/v2/checkoutSessions',
          { 'Content-Type': 'application/json', 'x-amz-pay-date': timestamp, 'x-amz-pay-host': apiRegion, 'x-amz-pay-region': CFG.amazonPay.region, 'Authorization': authHeader },
          bodyStr
        );
        const session = JSON.parse(apRes);
        res.writeHead(200, { ...cors, 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, checkoutSessionId: session.checkoutSessionId, redirectUrl: session.webCheckoutDetails?.amazonPayRedirectUrl }));
      } catch(e) {
        res.writeHead(500, { ...cors, 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: e.message }));
      }
    });
    return;
  }

  // ── メール送信 ─────────────────────────────────────
  if (url.pathname === '/api/order/send-mail' && req.method === 'POST') {
    let body = '';
    req.on('data', d => body += d);
    req.on('end', async () => {
      if (!mailTransport) {
        res.writeHead(503, { ...cors, 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ ok: false, error: 'メール未設定。.envにMAIL_FROMとMAIL_PASSを入力してください' }));
      }
      try {
        const order = JSON.parse(body);
        const itemsHtml = (order.items || []).map(i =>
          `<tr><td style="padding:6px 8px;border-bottom:1px solid #eee">${i.name}</td><td style="padding:6px 8px;border-bottom:1px solid #eee;text-align:center">${i.size || '-'}</td><td style="padding:6px 8px;border-bottom:1px solid #eee;text-align:right">¥${(i.price||0).toLocaleString()}</td></tr>`
        ).join('');
        const customerHtml = `
          <p style="font-family:sans-serif;font-size:14px;line-height:2;color:#555">
            ${order.name || ''} 様<br><br>
            この度はNOREMにてご注文いただきありがとうございます。<br>
            以下の内容でご注文を承りました。
          </p>
          <table style="width:100%;border-collapse:collapse;margin:16px 0;font-size:13px">
            <thead><tr style="background:#f5f5f5"><th style="padding:8px;text-align:left">商品</th><th style="padding:8px">サイズ</th><th style="padding:8px;text-align:right">金額</th></tr></thead>
            <tbody>${itemsHtml}</tbody>
            <tfoot><tr><td colspan="2" style="padding:10px 8px;font-weight:bold;text-align:right">合計</td><td style="padding:10px 8px;font-weight:bold;text-align:right">¥${(order.total||0).toLocaleString()}（税込）</td></tr></tfoot>
          </table>
          <p style="font-family:sans-serif;font-size:13px;color:#555;line-height:1.8">
            お支払い方法: ${order.payMethod || '-'}<br>
            お届け先: ${order.address || '-'}<br><br>
            ${order.payMethod === '銀行振込' ? '振込先口座は別途ご案内いたします。ご入金確認後、発送手配を行います。<br><br>' : ''}
            ご不明な点はお気軽にお問い合わせください。<br>
            NOREM
          </p>`;
        const adminHtml = `<p style="font-family:sans-serif;font-size:14px">新規注文が入りました。</p><p style="font-size:13px;color:#555">氏名: ${order.name}<br>メール: ${order.email}<br>合計: ¥${(order.total||0).toLocaleString()}<br>支払: ${order.payMethod}</p>${itemsHtml ? `<table style="width:100%;border-collapse:collapse;font-size:13px"><tbody>${itemsHtml}</tbody></table>` : ''}`;
        await mailTransport.sendMail({
          from:    `"NOREM" <${CFG.mail.from}>`,
          to:      order.email,
          subject: `【NOREM】ご注文ありがとうございます（注文番号: ${order.orderId || '-'}）`,
          html:    customerHtml,
        });
        await mailTransport.sendMail({
          from:    `"NOREM Order" <${CFG.mail.from}>`,
          to:      CFG.mail.admin,
          subject: `【NOREM 新規注文】${order.name} / ¥${(order.total||0).toLocaleString()}`,
          html:    adminHtml,
        });
        res.writeHead(200, { ...cors, 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      } catch(e) {
        console.error('Mail error:', e);
        res.writeHead(500, { ...cors, 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: e.message }));
      }
    });
    return;
  }

  // ── 決済設定確認 API ──────────────────────────────
  if (url.pathname === '/api/payment/config' && req.method === 'GET') {
    res.writeHead(200, { ...cors, 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      stripe:    { enabled: !!stripe,          pubKey: CFG.stripe.pub && !CFG.stripe.pub.includes('ここに') ? CFG.stripe.pub : null },
      paypay:    { enabled: !!(CFG.paypay.key  && !CFG.paypay.key.includes('ここに')) },
      paypal:    { enabled: !!(CFG.paypal.clientId && !CFG.paypal.clientId.includes('ここに')), clientId: CFG.paypal.clientId && !CFG.paypal.clientId.includes('ここに') ? CFG.paypal.clientId : null, env: CFG.paypal.env },
      amazonPay: { enabled: !!(CFG.amazonPay.merchant && !CFG.amazonPay.merchant.includes('ここに')), merchantId: CFG.amazonPay.merchant && !CFG.amazonPay.merchant.includes('ここに') ? CFG.amazonPay.merchant : null, storeId: CFG.amazonPay.store && !CFG.amazonPay.store.includes('ここに') ? CFG.amazonPay.store : null },
      mail:      { enabled: !!mailTransport },
    }));
    return;
  }

  res.writeHead(404, cors); res.end('Not found');
});

// ── サイト用 no-cache サーバー（port 8765）──
const mime = {
  '.html':'text/html;charset=utf-8', '.js':'application/javascript',
  '.css':'text/css', '.png':'image/png', '.jpg':'image/jpeg',
  '.jpeg':'image/jpeg', '.webp':'image/webp', '.svg':'image/svg+xml',
  '.gif':'image/gif', '.ico':'image/x-icon', '.txt':'text/plain',
};
const SITE_PORT = 8765;
require('http').createServer((req, res) => {
  let filePath = path.join(DIR, decodeURIComponent(req.url.split('?')[0]));
  if (filePath.endsWith('/')) filePath += 'index.html';
  if (!fs.existsSync(filePath)) { res.writeHead(404); res.end('Not found'); return; }
  const ext  = path.extname(filePath).toLowerCase();
  const type = mime[ext] || 'application/octet-stream';
  // JSファイルはキャッシュしない（保存後すぐ反映）
  const noCache = ext === '.js' || ext === '.html';
  res.writeHead(200, {
    'Content-Type': type,
    'Cache-Control': noCache ? 'no-store, no-cache, must-revalidate' : 'public, max-age=300',
  });
  fs.createReadStream(filePath).pipe(res);
}).listen(SITE_PORT, () => {
  console.log(`🌐 サイト（キャッシュなし）: http://localhost:${SITE_PORT}`);
});

server.listen(PORT, () => {
  console.log(`🔐 NOREM 管理画面: http://localhost:${PORT}\n`);
});
