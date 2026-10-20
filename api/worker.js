// JY blog API: D1 (feed + articles), two R2 image hosts (FEED_IMG, ART_IMG), admin page.
import ADMIN from './admin.html';

const ORIGINS = ['https://gguioo.github.io'];
const IMG_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/avif'];

const cors = req => {
  const o = req.headers.get('Origin');
  return {
    'Access-Control-Allow-Origin': ORIGINS.includes(o) || /^http:\/\/localhost(:\d+)?$/.test(o || '') ? o : ORIGINS[0],
    'Access-Control-Allow-Methods': 'GET,POST,DELETE,OPTIONS',
    'Access-Control-Allow-Headers': 'Authorization,Content-Type',
    Vary: 'Origin',
  };
};
const json = (req, data, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', ...cors(req) } });

const authed = (req, env) => req.headers.get('Authorization') === `Bearer ${env.ADMIN_TOKEN}`;

// image URL <-> bucket key: /f/<key> lives in FEED_IMG, /a/<key> in ART_IMG
const keysIn = (text, prefix) => [...String(text || '').matchAll(new RegExp(`/${prefix}/([\\w.-]+)`, 'g'))].map(m => m[1]);

const plain = html => String(html).replace(/<(script|style)[\s\S]*?<\/\1>/gi, '').replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();

async function upload(req, env, url, bucket, prefix) {
  const file = (await req.formData()).get('file');
  if (!file || typeof file === 'string') return json(req, { error: 'no file' }, 400);
  if (!IMG_TYPES.includes(file.type)) return json(req, { error: 'not an image' }, 400);
  const ext = file.type.split('/')[1].replace('jpeg', 'jpg');
  const key = `${crypto.randomUUID()}.${ext}`;
  await bucket.put(key, file.stream(), { httpMetadata: { contentType: file.type } });
  return json(req, { url: `${url.origin}/${prefix}/${key}` });
}

async function serveImg(bucket, key) {
  const obj = await bucket.get(key);
  if (!obj) return new Response('not found', { status: 404 });
  return new Response(obj.body, {
    headers: {
      'Content-Type': obj.httpMetadata?.contentType || 'application/octet-stream',
      'Cache-Control': 'public, max-age=31536000, immutable',
      'Access-Control-Allow-Origin': '*',
    },
  });
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const p = url.pathname;
    const m = req.method;
    if (m === 'OPTIONS') return new Response(null, { headers: cors(req) });

    if (p === '/' || p === '/admin') return new Response(ADMIN, { headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' } });
    if (m === 'GET' && p.startsWith('/f/')) return serveImg(env.FEED_IMG, p.slice(3));
    if (m === 'GET' && p.startsWith('/a/')) return serveImg(env.ART_IMG, p.slice(3));

    const db = env.DB;
    try {
      // ---------- public reads ----------
      if (m === 'GET' && p === '/api/feed') {
        const { results } = await db.prepare('SELECT id,text,photos,created_at FROM feed ORDER BY created_at DESC').all();
        return json(req, results.map(r => ({ ...r, photos: JSON.parse(r.photos) })));
      }
      if (m === 'GET' && p === '/api/articles') {
        const { results } = await db.prepare('SELECT id,title,cover,excerpt,minutes,created_at FROM articles ORDER BY created_at DESC').all();
        return json(req, results);
      }
      let id = p.match(/^\/api\/articles\/(\d+)$/)?.[1];
      if (m === 'GET' && id) {
        const a = await db.prepare('SELECT * FROM articles WHERE id=?').bind(id).first();
        return a ? json(req, a) : json(req, { error: 'not found' }, 404);
      }

      // ---------- admin ----------
      if (!p.startsWith('/api/')) return new Response('not found', { status: 404 });
      if (!authed(req, env)) return json(req, { error: 'unauthorized' }, 401);

      if (m === 'GET' && p === '/api/check') return json(req, { ok: true });
      if (m === 'POST' && p === '/api/upload/feed') return upload(req, env, url, env.FEED_IMG, 'f');
      if (m === 'POST' && p === '/api/upload/article') return upload(req, env, url, env.ART_IMG, 'a');

      // 清理死图：R2 里没被任何碎片/长文引用、且上传超过 1 小时的图片
      if (m === 'POST' && p === '/api/cleanup') {
        const feed = (await db.prepare('SELECT photos FROM feed').all()).results;
        const arts = (await db.prepare('SELECT cover,html FROM articles').all()).results;
        const usedF = new Set(feed.flatMap(r => keysIn(r.photos, 'f')));
        const usedA = new Set(arts.flatMap(r => keysIn(r.cover + ' ' + r.html, 'a')));
        const cutoff = Date.now() - 3600e3;
        const sweep = async (bucket, used) => {
          let cursor, dead = [];
          do {
            const l = await bucket.list({ cursor, limit: 1000 });
            for (const o of l.objects) if (!used.has(o.key) && o.uploaded.getTime() < cutoff) dead.push(o.key);
            cursor = l.truncated ? l.cursor : undefined;
          } while (cursor);
          for (let i = 0; i < dead.length; i += 1000) await bucket.delete(dead.slice(i, i + 1000));
          return dead.length;
        };
        return json(req, { ok: true, feed: await sweep(env.FEED_IMG, usedF), article: await sweep(env.ART_IMG, usedA) });
      }

      if (m === 'POST' && p === '/api/feed') {
        const { text = '', photos = [] } = await req.json();
        if (!text.trim() && !photos.length) return json(req, { error: 'empty' }, 400);
        const r = await db.prepare('INSERT INTO feed (text,photos,created_at) VALUES (?,?,?) RETURNING id')
          .bind(text.trim(), JSON.stringify(photos), new Date().toISOString()).first();
        return json(req, r, 201);
      }
      id = p.match(/^\/api\/feed\/(\d+)$/)?.[1];
      if (m === 'DELETE' && id) {
        const r = await db.prepare('DELETE FROM feed WHERE id=? RETURNING photos').bind(id).first();
        if (!r) return json(req, { error: 'not found' }, 404);
        const keys = keysIn(r.photos, 'f');
        if (keys.length) await env.FEED_IMG.delete(keys);
        return json(req, { ok: true, removedImages: keys.length });
      }

      if (m === 'POST' && p === '/api/articles') {
        const { title = '', cover = '', html = '' } = await req.json();
        if (!title.trim() || !html.trim()) return json(req, { error: 'title and html required' }, 400);
        const text = plain(html);
        const r = await db.prepare('INSERT INTO articles (title,cover,html,excerpt,minutes,created_at) VALUES (?,?,?,?,?,?) RETURNING id')
          .bind(title.trim(), cover.trim(), html, text.slice(0, 90), Math.max(1, Math.round(text.length / 400)), new Date().toISOString()).first();
        return json(req, r, 201);
      }
      id = p.match(/^\/api\/articles\/(\d+)$/)?.[1];
      if (m === 'DELETE' && id) {
        const r = await db.prepare('DELETE FROM articles WHERE id=? RETURNING cover,html').bind(id).first();
        if (!r) return json(req, { error: 'not found' }, 404);
        const keys = [...new Set(keysIn(r.cover + ' ' + r.html, 'a'))];
        if (keys.length) await env.ART_IMG.delete(keys);
        return json(req, { ok: true, removedImages: keys.length });
      }
      return json(req, { error: 'not found' }, 404);
    } catch (e) {
      return json(req, { error: String(e.message || e) }, 500);
    }
  },
};
