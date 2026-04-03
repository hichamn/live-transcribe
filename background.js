chrome.runtime.onMessage.addListener((msg) => {
  if (msg.action === 'openWindow') {
    chrome.windows.create({
      url: chrome.runtime.getURL('transcribe.html'),
      type: 'popup',
      width: 420,
      height: 750
    });
  }
});
