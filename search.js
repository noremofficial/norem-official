/**
 * NOREM サイト内検索
 * 全ページの <script src="search.js"></script> で有効化
 */
(function () {
  // ── CSS ────────────────────────────────────────────────────
  const style = document.createElement('style');
  style.textContent = `
    #searchOverlay {
      position: fixed; top: 0; left: 0; right: 0; z-index: 1000;
      background: rgba(255,255,255,0.85);
      backdrop-filter: blur(16px);
      display: flex; flex-direction: column; align-items: center;
      padding: 72px 24px 32px;
      opacity: 0; pointer-events: none;
      transition: opacity 0.2s;
      border-bottom: 1px solid #e4e0da;
      box-shadow: 0 4px 24px rgba(0,0,0,0.06);
    }
    #searchOverlay.open { opacity: 1; pointer-events: auto; }

    #searchClose {
      position: absolute; top: 20px; right: 28px;
      background: none; border: none; cursor: pointer;
      font-size: 0.6rem; letter-spacing: 0.18em; text-transform: uppercase;
      color: #9a9690; font-family: 'Lato', sans-serif; transition: color 0.2s;
    }
    #searchClose:hover { color: #0d0d0d; }

    #searchInputWrap {
      width: 100%; max-width: 520px;
      display: flex; align-items: center; gap: 10px;
      border-bottom: 1px solid #0d0d0d; padding-bottom: 8px;
      margin-bottom: 20px;
    }

    #searchInput {
      flex: 1; border: none; outline: none; background: transparent;
      font-size: 1.1rem; font-family: 'Lato', sans-serif;
      letter-spacing: 0.04em; color: #0d0d0d;
    }
    #searchInput::placeholder { color: #c8c4be; }

    #searchResults {
      width: 100%; max-width: 520px;
      display: flex; flex-direction: column; max-height: 40vh; overflow-y: auto;
    }

    .sr-item {
      display: flex; align-items: center; gap: 12px;
      padding: 10px 0; border-bottom: 1px solid #e4e0da;
      text-decoration: none; color: #0d0d0d; transition: opacity 0.2s;
    }
    .sr-item:hover { opacity: 0.5; }
    .sr-img { width: 40px; height: 56px; object-fit: cover; background: #e8e8e8; flex-shrink: 0; }
    .sr-img-placeholder { width: 40px; height: 56px; background: #f0eeea; flex-shrink: 0; display: flex; align-items: center; justify-content: center; }
    .sr-info { flex: 1; display: flex; flex-direction: column; gap: 3px; }
    .sr-title { font-size: 0.75rem; letter-spacing: 0.04em; }
    .sr-type  { font-size: 0.55rem; letter-spacing: 0.16em; text-transform: uppercase; color: #9a9690; }

    .sr-none {
      font-size: 0.72rem; color: #9a9690;
      text-align: center; padding: 20px 0; letter-spacing: 0.1em;
    }
  `;
  document.head.appendChild(style);

  // ── HTML ───────────────────────────────────────────────────
  document.body.insertAdjacentHTML('beforeend', `
    <div id="searchOverlay" role="dialog" aria-label="検索">
      <button id="searchClose">
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round">
          <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
        </svg>
        Close
      </button>
      <div id="searchInputWrap">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#9a9690" stroke-width="1.5" stroke-linecap="round">
          <circle cx="11" cy="11" r="7"/><line x1="16.5" y1="16.5" x2="22" y2="22"/>
        </svg>
        <input id="searchInput" type="text" placeholder="キーワードを入力..." autocomplete="off" />
      </div>
      <div id="searchResults"></div>
    </div>
  `);

  // ── インデックス構築 ────────────────────────────────────────
  function buildIndex() {
    const idx = [
      { title: 'Home',       url: 'index.html',     type: 'ページ' },
      { title: 'About',      url: 'about.html',      type: 'ページ' },
      { title: 'Collection', url: 'collection.html', type: 'ページ' },
      { title: 'Shop',       url: 'shop.html',       type: 'ページ' },
      { title: 'News',       url: 'news.html',       type: 'ページ' },
      { title: 'Contact',    url: 'contact.html',    type: 'ページ' },
    ];

    if (typeof PRODUCTS_DATA !== 'undefined' && typeof nameFromFile === 'function') {
      PRODUCTS_DATA.forEach(p => {
        const name = nameFromFile(p.images[0]);
        if (name) idx.push({
          title: name,
          url: `product.html?id=${p.id}`,
          type: '商品',
          img: (p.folder && p.images[0]) ? `${p.folder}/${p.images[0]}` : '',
        });
      });
    }

    if (typeof NEWS_DATA !== 'undefined') {
      NEWS_DATA.forEach(n => {
        idx.push({ title: n.title, url: `news.html#news-${n.id}`, type: 'ニュース', date: n.date, sub: n.excerpt });
      });
    }

    return idx;
  }

  // ── DOM refs ───────────────────────────────────────────────
  const overlay = document.getElementById('searchOverlay');
  const input   = document.getElementById('searchInput');
  const results = document.getElementById('searchResults');

  function openSearch() {
    overlay.classList.add('open');
    document.body.style.overflow = 'hidden';
    setTimeout(() => input.focus(), 80);
  }

  function closeSearch() {
    overlay.classList.remove('open');
    document.body.style.overflow = '';
    input.value = '';
    results.innerHTML = '';
  }

  // ── イベント ────────────────────────────────────────────────
  document.querySelectorAll('.nav-icon[aria-label="Search"]').forEach(btn => {
    btn.addEventListener('click', openSearch);
  });

  document.getElementById('searchClose').addEventListener('click', closeSearch);

  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && overlay.classList.contains('open')) closeSearch();
  });

  input.addEventListener('input', () => {
    const q = input.value.trim().toLowerCase();
    if (!q) { results.innerHTML = ''; return; }

    const hits = buildIndex().filter(item =>
      item.title.toLowerCase().includes(q) ||
      (item.sub && item.sub.toLowerCase().includes(q))
    );

    results.innerHTML = hits.length === 0
      ? '<p class="sr-none">No results found</p>'
      : hits.slice(0, 12).map(h => `
          <a href="${h.url}" class="sr-item">
            ${h.img
              ? `<img src="${h.img}" class="sr-img" alt="" onerror="this.style.display='none'">`
              : `<div class="sr-img-placeholder"></div>`}
            <span class="sr-info">
              <span class="sr-title">${h.title}</span>
              <span class="sr-type">${h.type}</span>
            </span>
          </a>`).join('');
  });

  // Shop nav link → PRODUCTS_DATAの最新シーズンへ
  (function () {
    const link = document.getElementById('navShopLink');
    if (!link || typeof PRODUCTS_DATA === 'undefined') return;
    const seasons = [...new Set(
      PRODUCTS_DATA.filter(p => p.published !== false).map(p => p.season)
    )].sort().reverse();
    if (seasons[0]) link.href = 'shop.html?season=' + encodeURIComponent(seasons[0]);
  })();
})();
