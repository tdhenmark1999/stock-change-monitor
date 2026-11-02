// Deterministic shop used by the tests and the demo. Its state is changed through /__state/<slug>.
import http from 'node:http';

const initial = () => ({
  title: 'Laugenpumpe Bosch 00144978',
  price: "CHF 49.90",
  stock: 'Auf Lager',
  quantity: 12,
  description: 'Original-Ersatzteil für Waschmaschinen.',
  hidden: [],
});

export function createFixture() {
  const products = new Map();
  const state = (slug) => {
    if (!products.has(slug)) products.set(slug, initial());
    return products.get(slug);
  };

  const render = (p) => {
    const part = (name, html) => (p.hidden.includes(name) ? '' : html);
    return `<!doctype html><html lang="de"><head><meta charset="utf-8"><title>${p.title}</title><style>body{font-family:sans-serif}</style></head><body>
<main class="product">
${part('title', `<h1 class="title">${p.title}</h1>`)}
${part('price', `<p class="price" data-amount="${p.price}">${p.price}</p>`)}
${part('stock', `<p class="stock">${p.stock}</p>`)}
${part('quantity', `<p class="quantity"><span class="qty">${p.quantity}</span> Stück</p>`)}
${part('availability', `<link class="availability" href="https://schema.org/${/nicht|aus/i.test(p.stock) ? 'OutOfStock' : 'InStock'}">`)}
${part('description', `<p class="description">${p.description}</p>`)}
</main></body></html>`;
  };

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://fixture');
    const send = (code, body, headers = {}) => {
      res.writeHead(code, { 'content-type': 'text/html; charset=utf-8', ...headers });
      res.end(body);
    };

    if (url.pathname === '/health') return send(200, 'ok');

    const stateMatch = /^\/__state\/([\w-]+)$/.exec(url.pathname);
    if (stateMatch && req.method === 'POST') {
      let body = '';
      req.on('data', (chunk) => (body += chunk));
      req.on('end', () => {
        const product = state(stateMatch[1]);
        Object.assign(product, JSON.parse(body || '{}'));
        send(200, JSON.stringify(product), { 'content-type': 'application/json' });
      });
      return;
    }

    const product = /^\/product\/([\w-]+)$/.exec(url.pathname);
    if (product) return send(200, render(state(product[1])));

    if (url.pathname === '/slow') return setTimeout(() => send(200, render(initial())), Number(url.searchParams.get('ms') ?? 60_000));
    if (url.pathname === '/huge') {
      res.writeHead(200, { 'content-type': 'text/html' });
      const chunk = 'x'.repeat(1024 * 1024);
      let sent = 0;
      const pump = () => {
        while (sent < 50) {
          sent++;
          if (!res.write(chunk)) return res.once('drain', pump);
        }
        res.end();
      };
      return pump();
    }
    if (url.pathname === '/redirect') return send(302, '', { location: url.searchParams.get('to') ?? '/' });
    if (url.pathname === '/status') return send(Number(url.searchParams.get('code') ?? 500), 'status', { ...(url.searchParams.get('retry') && { 'retry-after': url.searchParams.get('retry') }) });
    if (url.pathname === '/blocked') return send(403, 'challenge', { 'cf-mitigated': 'challenge' });
    if (url.pathname === '/pdf') return send(200, '%PDF', { 'content-type': 'application/pdf' });
    return send(404, 'not found');
  });

  return server;
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  const port = Number(process.env.PORT ?? 4100);
  const server = createFixture().listen(port, '0.0.0.0', () => console.log(JSON.stringify({ msg: 'fixture listening', port })));
  process.on('SIGTERM', () => server.close(() => process.exit(0)));
}
