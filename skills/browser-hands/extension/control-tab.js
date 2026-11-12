// Makes Claude's control tab recognizable to the user.
// slashunderscore.com/#claude-hands: keep the site, add a small badge. example.com (fallback): replace the page.
const NAME = 'Claude Browser Hands';
const NOTE = 'Ovládací karta Clauda: odsud spravuje rozšíření a karty. Nic tu nedělej, Claude ji po sobě zavře.';
const icon = (size) => chrome.runtime.getURL(`icons/icon${size}.png`);

if (location.hostname === 'example.com') {
  document.title = NAME;
  document.head.append(Object.assign(document.createElement('link'), { rel: 'icon', href: icon(32) }));
  document.body.innerHTML = '';
  document.querySelectorAll('style, link[rel=stylesheet]').forEach((e) => e.remove()); // example.com's own div/body rules break the layout
  const style = document.createElement('style'); // follow the OS dark mode, both palettes explicit
  style.textContent = `body{margin:0!important;padding:0!important;background:#faf7f2!important;color:#2b2b2b!important}
    @media (prefers-color-scheme:dark){body{background:#1f1f1f!important;color:#ece9e4!important}}`;
  document.head.append(style);
  const box = document.createElement('div');
  box.style.cssText = 'font:16px/1.5 system-ui,sans-serif;max-width:520px;margin:15vh auto;padding:0 16px;text-align:center';
  box.innerHTML = `<img src="${icon(128)}" width="64" height="64" alt="">
    <h1 style="font-size:22px;margin:12px 0 4px">${NAME}</h1><p>${NOTE}</p>`;
  document.body.append(box);
} else if (location.hash === '#claude-hands') {
  document.title = `${NAME} · ${document.title}`;
  const badge = document.createElement('div');
  badge.id = 'claude-hands-badge';
  badge.title = NOTE;
  badge.style.cssText = `position:fixed;right:16px;bottom:16px;z-index:2147483647;display:flex;align-items:center;gap:8px;
    padding:6px 12px 6px 6px;border-radius:999px;background:#1f1f1f;color:#ece9e4;font:13px/1.2 system-ui,sans-serif;
    box-shadow:0 2px 12px rgba(0,0,0,.35);max-width:calc(100vw - 32px)`;
  badge.innerHTML = `<img src="${icon(32)}" width="24" height="24" alt=""><span><b>${NAME}</b> · ovládací karta, Claude ji po sobě zavře</span>`;
  document.body.append(badge);
}
