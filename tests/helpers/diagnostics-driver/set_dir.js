// evalfile/fevalfile payload for tests/diagnostics-live-driver.mjs.
(() => {
  const input = [...document.querySelectorAll('input[type="text"], input:not([type])')]
    .find(i => i.offsetParent && /Downloads|path/i.test(i.value + (i.placeholder || '')));
  if (!input) return 'INPUT_NOT_FOUND';
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
  setter.call(input, '/tmp/diag-reports');
  input.dispatchEvent(new Event('input', { bubbles: true }));
  const btn = [...document.querySelectorAll('button')].find(b => b.textContent.includes('Set Directory'));
  if (!btn) return 'BUTTON_NOT_FOUND';
  btn.click();
  return 'set directory to /tmp/diag-reports';
})()
