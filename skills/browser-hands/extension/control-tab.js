// Turns the https://example.com control tab into a self-explaining "Claude Browser Hands" page, so the user isn't puzzled by it.
document.title = 'Claude Browser Hands';
const icon = Object.assign(document.createElement('link'), { rel: 'icon', href: chrome.runtime.getURL('icons/icon32.png') });
document.head.append(icon);
document.body.innerHTML = '';
document.querySelectorAll('style, link[rel=stylesheet]').forEach((e) => e.remove()); // example.com's own div/body rules break the layout
const style = document.createElement('style'); // follow the OS dark mode, both palettes explicit
style.textContent = `body{margin:0!important;padding:0!important;background:#faf7f2!important;color:#2b2b2b!important}
  @media (prefers-color-scheme:dark){body{background:#1f1f1f!important;color:#ece9e4!important}}`;
document.head.append(style);
const box = document.createElement('div');
box.style.cssText = 'font:16px/1.5 system-ui,sans-serif;max-width:520px;margin:15vh auto;padding:0 16px;text-align:center';
box.innerHTML = `<img src="${chrome.runtime.getURL('icons/icon128.png')}" width="64" height="64" alt="">
  <h1 style="font-size:22px;margin:12px 0 4px">Claude Browser Hands</h1>
  <p>Ovládací karta Clauda: odsud spravuje rozšíření a karty. Nic tu nedělej, Claude ji po sobě zavře.</p>`;
document.body.append(box);
