// A tiny local store for testing price watches end to end.
//   npm run demo-shop                       -> http://127.0.0.1:4330/product/headphones
//   open http://127.0.0.1:4330/admin        -> change the price, then press "Check now" in the app
// The app blocks local addresses by default (SSRF protection), so start it with
//   WATCH_ALLOW_PRIVATE=1 npm start
// while testing, and restart it normally afterwards.
import http from 'node:http';

const products = {
  headphones: { name: 'Acme Noise-Cancelling Headphones', price: 129.99, currency: 'USD' },
  kettle: { name: 'Acme Electric Kettle', price: 49.0, currency: 'USD' },
  'text-only-lamp': { name: 'Acme Desk Lamp (no product data, AI must read it)', price: 35.5, currency: 'USD', textOnly: true },
};
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/robots.txt') { res.writeHead(200, { 'Content-Type': 'text/plain' }); return res.end('User-agent: *\nDisallow: /private/\n'); }
  if (url.pathname === '/set') {
    const p = products[url.searchParams.get('id')]; const v = Number(url.searchParams.get('price'));
    if (p && v > 0) p.price = v;
    res.writeHead(303, { Location: '/admin' }); return res.end();
  }
  if (url.pathname === '/admin' || url.pathname === '/') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    return res.end(`<!doctype html><meta charset="utf-8"><title>Demo shop admin</title><body style="font:16px system-ui;max-width:640px;margin:40px auto;padding:0 16px">
      <h1>Demo shop</h1><p>Copy a product link into the app, then lower its price here and press <b>Check now</b> on the watch.</p>
      ${Object.entries(products).map(([id, p]) => `<form action="/set" style="border:1px solid #ddd;border-radius:8px;padding:12px;margin:10px 0">
        <b>${esc(p.name)}</b><br><code>http://127.0.0.1:4330/product/${id}</code><br>
        <input type="hidden" name="id" value="${id}">Price: <input name="price" type="number" step="0.01" value="${p.price}"> ${p.currency} <button>Set price</button></form>`).join('')}
      <p>Blocked by robots.txt (to test that message): <code>http://127.0.0.1:4330/private/secret-item</code></p></body>`);
  }
  const m = url.pathname.match(/^\/(?:product|private)\/([\w-]+)/);
  const p = m && products[m[1]];
  if (!p) { res.writeHead(404); return res.end('Not found'); }
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(`<!doctype html><html><head><meta charset="utf-8"><title>${esc(p.name)} | Demo Shop</title>
    ${p.textOnly ? '' : `<script type="application/ld+json">${JSON.stringify({ '@context': 'https://schema.org', '@type': 'Product', name: p.name, offers: { '@type': 'Offer', price: p.price.toFixed(2), priceCurrency: p.currency, availability: 'https://schema.org/InStock' } })}</script>`}
    </head><body><h1>${esc(p.name)}</h1><p class="price">Now only $${p.price.toFixed(2)}</p><p>Was $${(p.price * 1.25).toFixed(2)}. Free shipping over $50.</p></body></html>`);
}).listen(Number(process.env.DEMO_SHOP_PORT || 4330), '127.0.0.1', () => console.log(`Demo shop: http://127.0.0.1:${process.env.DEMO_SHOP_PORT || 4330}/admin`));
