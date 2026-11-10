import app from '../src/app.js';

export default function handler(req, res) {
  const [pathname, search] = (req.url || '/').split('?');
  const suffix = search ? `?${search}` : '';

  if (pathname === '/api' || pathname === '/api/') {
    req.url = `/${suffix}`;
  } else if (pathname.startsWith('/api/')) {
    req.url = `${pathname.slice(4)}${suffix}`;
  } else if (pathname.startsWith('/')) {
    req.url = `${pathname}${suffix}`;
  }

  return app(req, res);
}