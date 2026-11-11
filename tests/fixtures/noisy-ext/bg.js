chrome.storage.local.get('count').then((s) => s.count || chrome.storage.local.set({ apiKey: 'abc', count: 1 }));
console.error('noisy startup error');
