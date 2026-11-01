/* Tablet app start-up: open the on-tablet database, route the app's API calls
   to it, then start the normal app. */

window.__MT_LOCAL__ = true;

async function boot() {
  const { setTransport, state } = await import('./core.js');
  let engine;
  try {
    engine = await import('./engine.js');
    await engine.startEngine();
  } catch (err) {
    document.body.innerHTML = '';
    const box = document.createElement('div');
    box.style.cssText = 'max-width:480px;margin:15vh auto;padding:24px;font:16px system-ui;';
    box.textContent = 'This browser won’t let the app store data (' + (err && err.message) + '). '
      + 'Private/incognito mode blocks it: open the app in a normal window.';
    document.body.append(box);
    return;
  }
  state.local = true;
  state.engine = engine;
  setTransport((method, url, body) => engine.request(method, url, body));

  // Ask the browser not to clear our data when space is low. Browsers mostly
  // grant this to apps added to the home screen.
  try { if (navigator.storage && navigator.storage.persist) state.persisted = await navigator.storage.persist(); } catch { /* */ }

  // Offline support: cache the app's files.
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch((err) => console.warn('Offline mode unavailable:', err));
  }

  const app = await import('./app.js');
  app.boot();
}

boot();
