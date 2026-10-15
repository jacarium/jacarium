// evalfile/fevalfile payload for tests/diagnostics-live-driver.mjs.
(() => {
  const body = document.body;
  return {
    hasNoData: /No Data Available|No SAR|No CPU/i.test(body.innerText),
    textSnippet: body.innerText.replace(/\s+/g, ' ').slice(0, 160),
    bodyH: body.scrollHeight,
  };
})()
