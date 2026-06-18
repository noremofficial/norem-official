#!/usr/bin/env node
/**
 * NOREM 商品データ自動生成スクリプト
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * 実行方法: node build.js
 *
 * ■ 自動でやること
 *   1. products/ フォルダをスキャン
 *   2. 画像ごとにテキストファイル（.txt）を自動生成
 *   3. products-data.js を更新
 *
 * ■ テキストファイルの編集方法
 *   products/シーズン/画像名.txt を開いて3つの欄に入力するだけ
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 */

const fs   = require('fs');
const path = require('path');
const vm   = require('vm');
const { execSync } = require('child_process');

const PRODUCTS_DIR = path.join(__dirname, 'products');
const META_FILE    = path.join(__dirname, 'products-meta.js');
const OUTPUT_FILE  = path.join(__dirname, 'products-data.js');

const IMG_EXT  = /\.(png|jpg|jpeg|webp|gif|PNG|JPG|JPEG|WEBP|GIF)$/;
const IS_VARIANT = /[-−–]\s*\d+\.(png|jpg|jpeg|webp|gif|PNG|JPG|JPEG|WEBP|GIF)$/;
const PNG_EXT  = /\.(png|PNG)$/;

// ── PNG → JPEG 自動変換 ────────────────────────────
function convertPngsToJpeg(dir) {
  if (!fs.existsSync(dir)) return;
  let count = 0;
  for (const f of fs.readdirSync(dir)) {
    if (!PNG_EXT.test(f)) continue;
    const src  = path.join(dir, f);
    const dest = path.join(dir, f.replace(PNG_EXT, '.jpg'));
    try {
      execSync(`sips -s format jpeg -s formatOptions 85 "${src}" --out "${dest}"`, { stdio: 'ignore' });
      fs.unlinkSync(src);
      count++;
    } catch (e) {
      console.log(`  ⚠ 変換失敗: ${f}`);
    }
  }
  if (count > 0) console.log(`  🖼 ${count}枚のPNGをJPEGに変換しました`);
}

// productsフォルダ内の各シーズンフォルダを変換
if (fs.existsSync(PRODUCTS_DIR)) {
  for (const season of fs.readdirSync(PRODUCTS_DIR)) {
    const seasonDir = path.join(PRODUCTS_DIR, season);
    if (fs.statSync(seasonDir).isDirectory()) convertPngsToJpeg(seasonDir);
  }
}

// ── メタ情報（価格・サイズ等）を読み込む ──────────
let META = {};
try {
  META = require(META_FILE);
  console.log('✓ products-meta.js を読み込みました');
} catch (e) {
  console.log('ℹ products-meta.js が見つかりません（スキップ）');
}

// ── 管理画面データ（admin-data.json）を上書きマージ ──
let ADMIN_DATA = {};
const ADMIN_FILE = path.join(__dirname, 'admin-data.json');
if (fs.existsSync(ADMIN_FILE)) {
  try {
    ADMIN_DATA = JSON.parse(fs.readFileSync(ADMIN_FILE, 'utf8'));
    console.log('✓ admin-data.json を読み込みました');
  } catch(e) {
    console.log('ℹ admin-data.json の読み込みに失敗しました');
  }
}

// ── テキストファイルのテンプレート ────────────────
const TXT_TEMPLATE = `# 商品情報
素材：
伸縮性：
透け感：

# サイズ
※全て平置きでの採寸となります。

（Sサイズ）
ウエスト：
ヒップ：

（Mサイズ）
ウエスト：
ヒップ：

# 商品紹介
（商品の紹介文・コピーライティングを入力）
`;

// ── テキストファイルを読み込む ─────────────────────
function readTxt(dir, imageFile) {
  const base    = imageFile.replace(/\.[^.]+$/, '');
  const txtPath = path.join(dir, `${base}.txt`);

  // なければテンプレートを作成
  if (!fs.existsSync(txtPath)) {
    fs.writeFileSync(txtPath, TXT_TEMPLATE, 'utf8');
    console.log(`    📝 テンプレート生成: ${base}.txt`);
    return { infoText: '', sizeText: '', description: '' };
  }

  const content = fs.readFileSync(txtPath, 'utf8');
  const result  = { infoText: '', sizeText: '', description: '' };
  let current   = null;
  const lines   = { infoText: [], sizeText: [], description: [] };
  const map     = { '商品情報': 'infoText', 'サイズ': 'sizeText', '商品紹介': 'description' };

  for (const line of content.split('\n')) {
    if (line.startsWith('# ')) {
      current = map[line.slice(2).trim()] || null;
    } else if (current) {
      lines[current].push(line);
    }
  }

  for (const key of Object.keys(result)) {
    result[key] = lines[key].join('\n').trim();
  }
  return result;
}

// ── シーズンフォルダをスキャン ──────────────────────
if (!fs.existsSync(PRODUCTS_DIR)) {
  console.error('✗ products/ フォルダが見つかりません');
  process.exit(1);
}

const seasons = fs.readdirSync(PRODUCTS_DIR)
  .filter(f => fs.statSync(path.join(PRODUCTS_DIR, f)).isDirectory())
  .sort().reverse();

console.log(`\n📁 シーズン: ${seasons.join(', ') || '(なし)'}`);

const products = [];
let id = 1;
let homeCount = 0;

for (const season of seasons) {
  const dir = path.join(PRODUCTS_DIR, season);

  const allFiles   = fs.readdirSync(dir).filter(f => IMG_EXT.test(f)).sort();
  const mainImages = allFiles.filter(f => !IS_VARIANT.test(f));

  console.log(`  ${season}: ${mainImages.length}個の画像`);

  for (const file of mainImages) {
    const base = file.replace(/\.[^.]+$/, '');

    // base-1, base-2, base−1 … をすべて収集して番号順に並べる
    const variants = allFiles
      .filter(f => IS_VARIANT.test(f) && (
        f.startsWith(base + '-') ||
        f.startsWith(base + '−') ||
        f.startsWith(base + '–')
      ))
      .sort((a, b) => {
        const na = parseInt(a.match(/\d+/g)?.slice(-1)[0] || '0');
        const nb = parseInt(b.match(/\d+/g)?.slice(-1)[0] || '0');
        return na - nb;
      });

    const baseMeta  = META[file] || META[`${season}/${file}`] || {};
    const adminMeta = ADMIN_DATA[`products/${season}/${file}`] || ADMIN_DATA[`${season}/${file}`] || ADMIN_DATA[file] || {};
    const meta = Object.assign({}, baseMeta, adminMeta);
    const txt  = readTxt(dir, file);

    let showOnHome;
    if (meta.showOnHome !== undefined) {
      showOnHome = meta.showOnHome;
    } else {
      showOnHome = homeCount < 8;
    }
    if (showOnHome) homeCount++;

    products.push({
      id,
      season,
      folder:      `products/${season}`,
      images:      [file, ...variants],
      price:       meta.price  ?? 0,
      taxIn:       meta.taxIn  ?? true,
      status:      meta.status ?? 'available',
      showOnHome,
      date:        meta.date   ?? (20300101 - id),
      saleDate:    meta.saleDate ?? '',
      sizes:       meta.sizes  ?? [
        { label: '0', status: 'available' },
        { label: '1', status: 'available' },
        { label: '2', status: 'available' },
        { label: '3', status: 'available' },
      ],
      infoText:    meta.infoText    || txt.infoText,
      sizeText:    meta.sizeText    || txt.sizeText,
      description: meta.description || txt.description,
      sizeChart:   meta.sizeChart   ?? null,
      notes:       meta.notes       ?? '',
      careIcons:     meta.careIcons     ?? [],
      published:     meta.published     ?? true,
      imageLayout:    meta.imageLayout    || 'scroll',
      imageRotations: meta.imageRotations ?? [],
      categories:     meta.categories     ?? [],
    });

    id++;
  }
}

// ── コレクションフォルダをスキャン ──────────────────────
const COLLECTIONS_DIR = path.join(__dirname, 'collections');
const collections = [];

if (fs.existsSync(COLLECTIONS_DIR)) {
  const collSeasons = fs.readdirSync(COLLECTIONS_DIR)
    .filter(f => fs.statSync(path.join(COLLECTIONS_DIR, f)).isDirectory())
    .sort((a, b) => {
      const aTime = fs.statSync(path.join(COLLECTIONS_DIR, a)).birthtimeMs;
      const bTime = fs.statSync(path.join(COLLECTIONS_DIR, b)).birthtimeMs;
      return bTime - aTime; // 作成日が新しい順
    });

  console.log(`\n🎨 コレクション: ${collSeasons.join(', ') || '(なし)'}`);

  for (const season of collSeasons) {
    const dir = path.join(COLLECTIONS_DIR, season);
    const allFiles = fs.readdirSync(dir).filter(f => IMG_EXT.test(f)).sort();
    const topFile  = allFiles.find(f => /^top\./i.test(f)) || null;
    const looks    = allFiles.filter(f => !/^top\./i.test(f));

    console.log(`  ${season}: top=${topFile || 'なし'}, looks=${looks.length}枚`);

    collections.push({
      season,
      folder:     `collections/${season}`,
      keyVisual:  topFile,
      looks,
    });
  }
}

// ── home/ フォルダをスキャンして home-data.js を生成 ──────
const HOME_DIR = path.join(__dirname, 'home');
let homeImages = [];

if (fs.existsSync(HOME_DIR)) {
  // 既存の home-data.js があればリンク設定を引き継ぐ
  let existingLinks = {};
  const homeDataPath = path.join(__dirname, 'home-data.js');
  if (fs.existsSync(homeDataPath)) {
    try {
      const code = fs.readFileSync(homeDataPath, 'utf8');
      const match = code.match(/\[[\s\S]*\]/);
      if (match) {
        JSON.parse(match[0]).forEach(item => { existingLinks[item.src] = item.link; });
      }
    } catch(e) {}
  }

  homeImages = fs.readdirSync(HOME_DIR)
    .filter(f => IMG_EXT.test(f))
    .sort()
    .map(f => {
      const src = `home/${f}`;
      return { src, link: existingLinks[src] || 'collection.html' };
    });
  console.log(`\n🏠 HOME画像: ${homeImages.length}枚 (${homeImages.map(i => i.src).join(', ')})`);
} else {
  console.log('\n🏠 home/ フォルダが見つかりません（スキップ）');
}

const homeOutput = `// AUTO-GENERATED — node build.js を実行すると更新されます
const HOME_IMAGES = ${JSON.stringify(homeImages, null, 2)};
`;
fs.writeFileSync(path.join(__dirname, 'home-data.js'), homeOutput, 'utf8');
console.log('✓ home-data.js を更新しました');

// ── collections-data.js を生成（published フラグを適用）──
const collAdminData = ADMIN_DATA.collections || {};
const collectionsWithFlags = collections.map(c => {
  const override = collAdminData[c.season] || {};
  return Object.assign({}, c, {
    published:    override.published    !== undefined ? override.published : true,
    label:        override.label        || c.season,
    kvTitle:      override.kvTitle      || null,
    kvSeasonFont: override.kvSeasonFont || null,
    kvTitleFont:  override.kvTitleFont  || null,
  });
});
const collectionsOutput = `// AUTO-GENERATED — node build.js を実行すると更新されます
const COLLECTIONS_DATA = ${JSON.stringify(collectionsWithFlags, null, 2)};
`;
fs.writeFileSync(path.join(__dirname, 'collections-data.js'), collectionsOutput, 'utf8');
console.log('\n✓ collections-data.js を更新しました');

// ── about-data.js を生成 ─────────────────────────────
const aboutDefaults = {
  conceptTitle: '安心へ向かう',
  conceptBody:  '誰かの一部になれるように、誰かの居場所になれるように\n不安と葛藤の中で安心でいられる場所を見つけ出す。',
  designerName: 'Tatsuya',
  designerIg:   'https://www.instagram.com/tatsuya_vfd/',
};
const aboutData = Object.assign({}, aboutDefaults, ADMIN_DATA.about || {});

// sub-photo ファイルが存在するか確認して URL を付加
const ABOUT_DIR = path.join(__dirname, 'about');
['sp1', 'sp2', 'sp3'].forEach(sp => {
  if (aboutData[sp + 'Url']) return; // 既にセット済み
  const exts = ['jpg', 'jpeg', 'png', 'webp', 'PNG', 'JPG', 'JPEG'];
  for (const ext of exts) {
    const candidate = path.join(ABOUT_DIR, sp + '.' + ext);
    if (fs.existsSync(candidate)) {
      aboutData[sp + 'Url'] = 'about/' + sp + '.' + ext;
      break;
    }
  }
});
// heroUrl: about/hero.* または home/ 画像
if (!aboutData.heroUrl) {
  const heroExts = ['jpg', 'jpeg', 'png', 'webp', 'PNG', 'JPG'];
  for (const ext of heroExts) {
    const candidate = path.join(ABOUT_DIR, 'hero.' + ext);
    if (fs.existsSync(candidate)) {
      aboutData.heroUrl = 'about/hero.' + ext;
      break;
    }
  }
}

const aboutOutput = `// AUTO-GENERATED — node build.js を実行すると更新されます
const ABOUT_DATA = ${JSON.stringify(aboutData, null, 2)};
`;
fs.writeFileSync(path.join(__dirname, 'about-data.js'), aboutOutput, 'utf8');
console.log('\n✓ about-data.js を更新しました');

// ── news-data.js を再生成（admin オーバーライドをマージ）──────
const NEWS_SOURCE_FILE = path.join(__dirname, 'news-source.js');
let originalArticles = [];

// news-source.js がなければ現在の news-data.js をソースとして使う（初回のみ）
const NEWS_DATA_FILE = path.join(__dirname, 'news-data.js');
if (!fs.existsSync(NEWS_SOURCE_FILE) && fs.existsSync(NEWS_DATA_FILE)) {
  // news-data.js から配列を抽出して news-source.js に保存（一度だけ）
  const newsCode = fs.readFileSync(NEWS_DATA_FILE, 'utf8');
  fs.writeFileSync(NEWS_SOURCE_FILE, newsCode, 'utf8');
  console.log('\n✓ news-source.js を初期作成しました');
}

if (fs.existsSync(NEWS_SOURCE_FILE)) {
  try {
    // news-source.js はテンプレートリテラルを含む可能性があるので
    // module として直接 require する
    delete require.cache[require.resolve(NEWS_SOURCE_FILE)];
    // require() で読み込むために一時的に module.exports に代入するラッパーを使う
    const newsCode = fs.readFileSync(NEWS_SOURCE_FILE, 'utf8');
    // const/let は vm コンテキストに漏れないので Function で実行
    const fn = new Function('module', 'exports', newsCode + '\n;if(typeof NEWS_DATA!=="undefined")module.exports=NEWS_DATA;');
    const mod = { exports: [] };
    fn(mod, mod.exports);
    originalArticles = mod.exports || [];
    console.log(`ℹ news-source.js から ${originalArticles.length} 件の記事を読み込みました`);
  } catch(e) {
    console.log('ℹ news-source.js 読み込みエラー: ' + e.message);
  }
}

const newsAdminData   = ADMIN_DATA.news        || {};
const newArticles     = ADMIN_DATA.newArticles || [];

// オリジナル記事に admin オーバーライドをマージ（非公開も含める）
const mergedArticles = originalArticles.map(art => {
  const override = newsAdminData[String(art.id)] || {};
  return Object.assign({}, art, override);
});

// 新規記事（adminで追加）をすべて含める
const extraArticles = newArticles.map(a => Object.assign({}, a));

// 全記事（published フラグ付き）
const allNewsArticles = [...mergedArticles, ...extraArticles];

// news-data.js を書き出す（テンプレートリテラルを使わずJSON safe）
const newsLines = allNewsArticles.map(a => {
  return `  {
    id: ${JSON.stringify(a.id)},
    date: ${JSON.stringify(a.date || '')},
    category: ${JSON.stringify(a.category || '')},
    title: ${JSON.stringify(a.title || '')},
    excerpt: ${JSON.stringify(a.excerpt || '')},
    image: ${JSON.stringify(a.image || '')},
    images: ${JSON.stringify(a.images || [])},
    content: ${JSON.stringify(a.content || '')},
    url: ${JSON.stringify(a.url || ('news-article.html?id=' + a.id))},
    published: ${a.published === false ? 'false' : 'true'},
  }`;
}).join(',\n');

const newsOutput = `// AUTO-GENERATED — node build.js を実行すると更新されます
const NEWS_DATA = [
${newsLines}
];
`;
fs.writeFileSync(NEWS_DATA_FILE, newsOutput, 'utf8');
console.log('\n✓ news-data.js を更新しました');

// ── products-data.js を生成 ─────────────────────────
const output = `// AUTO-GENERATED — node build.js を実行すると更新されます

function nameFromFile(filename) {
  if (!filename) return '';
  return filename.replace(/\\.[^.]+$/, '').replace(/[-_]/g, ' ');
}

const PRODUCTS_DATA = ${JSON.stringify(products, null, 2)};
`;

fs.writeFileSync(OUTPUT_FILE, output, 'utf8');

console.log(`\n✅ 完了: ${products.length}個の商品を生成しました`);
console.log(`   テキストファイルを編集して node build.js を再実行すると反映されます\n`);
