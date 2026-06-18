// Cookie同意バナー + GA4 遅延ロード
(function () {
  const GA_ID = 'G-Y8VYE7805Z';
  const COOKIE_NAME = 'norem_cookie_consent';
  const EXPIRE_DAYS = 365;

  function getCookie(name) {
    return document.cookie.split('; ').reduce((acc, c) => {
      const [k, v] = c.split('=');
      return k === name ? decodeURIComponent(v) : acc;
    }, null);
  }

  function setCookie(name, value, days) {
    const d = new Date();
    d.setTime(d.getTime() + days * 24 * 60 * 60 * 1000);
    document.cookie = `${name}=${encodeURIComponent(value)};expires=${d.toUTCString()};path=/;SameSite=Lax`;
  }

  function loadGA() {
    if (window._gaLoaded) return;
    window._gaLoaded = true;
    const s = document.createElement('script');
    s.async = true;
    s.src = `https://www.googletagmanager.com/gtag/js?id=${GA_ID}`;
    document.head.appendChild(s);
    window.dataLayer = window.dataLayer || [];
    function gtag() { dataLayer.push(arguments); }
    window.gtag = gtag;
    gtag('js', new Date());
    gtag('config', GA_ID);
  }

  function hideBanner(banner) {
    banner.style.transform = 'translateY(120%)';
    setTimeout(() => banner.remove(), 400);
  }

  function showBanner() {
    const banner = document.createElement('div');
    banner.id = 'cookieBanner';
    banner.innerHTML = `
      <p class="cb-text">当サイトはGoogle Analytics等のCookieを使用しています。詳細は<a href="privacy-policy.html">プライバシーポリシー</a>をご確認ください。</p>
      <div class="cb-btns">
        <button class="cb-accept">同意する</button>
        <button class="cb-decline">拒否する</button>
      </div>`;

    const style = document.createElement('style');
    style.textContent = `
      #cookieBanner {
        position: fixed; bottom: 24px; left: 50%; transform: translateX(-50%) translateY(120%);
        z-index: 9999; background: #fff; border: 1px solid #e4e0da;
        padding: 20px 28px; display: flex; align-items: center; gap: 24px;
        max-width: 720px; width: calc(100% - 48px);
        box-shadow: 0 4px 24px rgba(0,0,0,0.08);
        transition: transform 0.4s cubic-bezier(0.16,1,0.3,1);
        font-family: 'Lato','Hiragino Sans',sans-serif;
      }
      #cookieBanner.cb-show { transform: translateX(-50%) translateY(0); }
      .cb-text { font-size: 0.72rem; color: #9a9690; line-height: 1.8; letter-spacing: 0.03em; flex: 1; }
      .cb-text a { color: #878787; }
      .cb-btns { display: flex; gap: 10px; flex-shrink: 0; }
      .cb-accept, .cb-decline {
        font-size: 0.6rem; letter-spacing: 0.18em; text-transform: uppercase;
        padding: 10px 18px; cursor: pointer; border: 1px solid #e4e0da;
        font-family: inherit; transition: background 0.2s, color 0.2s, border-color 0.2s;
        white-space: nowrap;
      }
      .cb-accept { background: #878787; color: #fff; border-color: #878787; }
      .cb-accept:hover { background: #6a6a6a; border-color: #6a6a6a; }
      .cb-decline { background: transparent; color: #9a9690; }
      .cb-decline:hover { border-color: #9a9690; color: #878787; }
      @media (max-width: 600px) {
        #cookieBanner { flex-direction: column; align-items: flex-start; gap: 14px; bottom: 16px; }
        .cb-btns { width: 100%; }
        .cb-accept, .cb-decline { flex: 1; text-align: center; }
      }`;
    document.head.appendChild(style);
    document.body.appendChild(banner);

    requestAnimationFrame(() => {
      requestAnimationFrame(() => banner.classList.add('cb-show'));
    });

    banner.querySelector('.cb-accept').addEventListener('click', () => {
      setCookie(COOKIE_NAME, 'accepted', EXPIRE_DAYS);
      loadGA();
      hideBanner(banner);
    });

    banner.querySelector('.cb-decline').addEventListener('click', () => {
      setCookie(COOKIE_NAME, 'declined', EXPIRE_DAYS);
      hideBanner(banner);
    });
  }

  // 既存の同意状態を確認
  const consent = getCookie(COOKIE_NAME);
  if (consent === 'accepted') {
    loadGA();
  } else if (!consent) {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', showBanner);
    } else {
      showBanner();
    }
  }
})();
