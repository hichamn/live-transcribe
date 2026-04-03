// Open transcribe window directly when extension icon is clicked
chrome.action.onClicked.addListener(() => {
  chrome.windows.create({
    url: chrome.runtime.getURL('transcribe.html'),
    type: 'popup',
    width: 420,
    height: 750
  });
});
