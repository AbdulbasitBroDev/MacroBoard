/**
 * MacroBoard - renderer error collector.
 *
 * Loaded FIRST, before Blockly, so it can capture anything that blows up during
 * startup and toolbox inflation. Errors are kept in `window.__mbErrors` (read by
 * the --selftest harness and the diagnostics panel) and forwarded to the main
 * process log so they end up in MacroBoard.log too.
 *
 * This exists because "clicking a category does nothing" has several possible
 * causes and none of them are visible without the real exception text.
 */
(function () {
  'use strict';

  const errors = [];
  window.__mbErrors = errors;

  function toText(value) {
    if (value && value.stack) return value.stack;
    if (value && value.message) return value.message;
    try {
      return typeof value === 'string' ? value : JSON.stringify(value);
    } catch (e) {
      return String(value);
    }
  }

  function record(kind, parts) {
    const entry = {
      kind: kind,
      text: parts.map(toText).join(' | '),
      at: Date.now(),
    };
    errors.push(entry);
    if (errors.length > 300) errors.shift();
    try {
      if (window.mb && window.mb.log) window.mb.log('error', '[' + kind + '] ' + entry.text);
    } catch (e) {
      /* logging must never throw */
    }
  }

  const origError = console.error.bind(console);
  console.error = function () {
    record('console.error', Array.prototype.slice.call(arguments));
    origError.apply(null, arguments);
  };

  window.addEventListener('error', function (e) {
    record('window.error', [
      (e.message || 'error') +
        (e.filename ? ' @ ' + e.filename + ':' + e.lineno + ':' + e.colno : '') +
        (e.error && e.error.stack ? '\n' + e.error.stack : ''),
    ]);
  });

  window.addEventListener('unhandledrejection', function (e) {
    record('unhandledrejection', [e.reason]);
  });
})();
