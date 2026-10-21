// The prerendered marketing pages' only script. scripts/build-cloudflare.js
// copies it into the build under a hashed name and puts it where the
// snapshot's main.js tag was, with main.js and the page's chunks named in
// data attributes.
//
// The HTML already holds the whole page, so nothing has to run before it can
// paint. The app is fetched once the browser reports the first contentful
// paint, not beside it: on a slow phone the HTML, fonts and hero image get the
// connection to themselves, and main.js and the chunks follow. A browser that
// does not report paint timing loads the app at once, as before. One that
// should but stays silent, a background tab say, loads it a second after the
// page has loaded.
(function () {
  var me = document.currentScript;
  if (!me) return;
  var main = me.getAttribute('data-main');
  var chunks = (me.getAttribute('data-chunks') || '').split(' ');
  var started = false;

  function start() {
    if (started) return;
    started = true;
    // The chunks as preloads, so they come down beside main.js instead of
    // waiting for it to run and ask.
    for (var i = 0; i < chunks.length; i++) {
      if (!chunks[i]) continue;
      var hint = document.createElement('link');
      hint.setAttribute('rel', 'preload');
      hint.setAttribute('as', 'script');
      hint.setAttribute('href', chunks[i]);
      document.head.appendChild(hint);
    }
    var app = document.createElement('script');
    app.src = main;
    document.head.appendChild(app);
  }

  var types = window.PerformanceObserver && window.PerformanceObserver.supportedEntryTypes;
  if (!types || types.indexOf('paint') === -1) {
    start();
    return;
  }
  new window.PerformanceObserver(function (list, observer) {
    if (list.getEntriesByName('first-contentful-paint').length) {
      observer.disconnect();
      start();
    }
  }).observe({ type: 'paint', buffered: true });
  window.addEventListener('load', function () { setTimeout(start, 1000); });
})();
