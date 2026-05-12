/* NEBCD — gtm.js
   Injects the Google Tag Manager <noscript> body tag.
   The <head> GTM snippet is hardcoded in each HTML file for
   optimal performance (must fire before other scripts).
   This file handles the <body> noscript fallback injection,
   keeping it out of each individual HTML file's <body> tag.
*/
(function () {
  const ns = document.createElement('noscript');
  const iframe = document.createElement('iframe');
  iframe.src = 'https://www.googletagmanager.com/ns.html?id=GTM-THCF3M4N';
  iframe.height = '0';
  iframe.width = '0';
  iframe.style.cssText = 'display:none;visibility:hidden';
  ns.appendChild(iframe);
  document.body.insertBefore(ns, document.body.firstChild);
})();
