/* 苦労BAR Telegram訪問通知（既存画面を変更しない） */
(() => {
  'use strict';
  const endpoint = 'https://script.google.com/macros/s/AKfycbwvs5KmiZrZ2c6SyNeXmblWOG8A_K2GjfXSdIfSajH8ErAIBhVrhHFRLZgwPrF4qUmo-g/exec';
  const query = new URLSearchParams(location.search);
  const preference = query.get('kbr_notify');
  if (preference === 'off' || preference === 'on') {
    try { localStorage.setItem('kbr_visit_notify_disabled', preference === 'off' ? '1' : '0'); } catch (_) {}
    query.delete('kbr_notify');
    try {
      const remaining = query.toString();
      history.replaceState(history.state, '', location.pathname + (remaining ? '?' + remaining : '') + location.hash);
    } catch (_) {}
    if (preference === 'off') return;
  }
  if (location.hostname !== 'onihata.github.io' || !location.pathname.startsWith('/kurobar-site/')) return;
  try { if (localStorage.getItem('kbr_visit_notify_disabled') === '1') return; } catch (_) {}
  if (/(bot|spider|crawler|headlesschrome|facebookexternalhit|telegrambot)/i.test(navigator.userAgent || '')) return;
  function createId() {
    if (window.crypto && typeof crypto.randomUUID === 'function') return crypto.randomUUID().replace(/-/g, '');
    if (window.crypto && typeof crypto.getRandomValues === 'function') {
      const bytes = crypto.getRandomValues(new Uint8Array(16));
      return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
    }
    return Date.now().toString(36) + Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
  }
  let visitorId;
  try {
    visitorId = localStorage.getItem('kbr_visit_anonymous_v1');
    if (!/^[a-zA-Z0-9_-]{16,70}$/.test(visitorId || '')) {
      visitorId = createId();
      localStorage.setItem('kbr_visit_anonymous_v1', visitorId);
    }
  } catch (_) { visitorId = createId(); }
  function pageLabel() {
    const hash = (location.hash || '').replace(/^#/, '').toLowerCase();
    return ({home: 'トップ', join: '新規募集', shirts: '公式Tシャツ', novel: '小説コーナー', about: 'サークル紹介'})[hash] || 'トップ';
  }
  function deviceLabel() {
    const ua = navigator.userAgent || '';
    if (/iPhone|iPod/i.test(ua)) return 'iPhone';
    if (/iPad/i.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)) return 'iPad';
    if (/Android/i.test(ua)) return 'Android';
    if (/Windows/i.test(ua)) return 'パソコン（Windows）';
    if (/Macintosh|Mac OS X/i.test(ua)) return 'パソコン（Mac）';
    return 'その他';
  }
  // 読み込み時のページを送信。30分以内の重複はサーバー側でまとめる。
  const params = new URLSearchParams({id: visitorId, page: pageLabel(), device: deviceLabel(), timestamp: String(Date.now())});
  const pixel = new Image(1, 1);
  window.__kurobarVisitPixel = pixel;
  pixel.onload = pixel.onerror = () => { window.__kurobarVisitPixel = null; };
  pixel.src = endpoint + '?' + params.toString();
})();
