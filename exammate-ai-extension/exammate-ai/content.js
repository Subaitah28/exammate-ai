// =====================================================
//  ExamMate AI – content.js
//  Runs on all pages. Exposes selected text to popup.
// =====================================================

// Listen for messages from popup to get selected text
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type === "GET_SELECTION") {
    const selected = window.getSelection()?.toString().trim() || "";
    sendResponse({ text: selected });
  }
  return false;
});
