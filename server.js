const express = require('express');
const path = require('path');
const { Pool } = require('pg');
const JSZip = require('jszip');

const app = express();
const PORT = process.env.PORT || 8080;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

async function initDB() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS pages (
        slug         TEXT PRIMARY KEY,
        name         TEXT,
        html         TEXT NOT NULL,
        netlify_url  TEXT,
        netlify_id   TEXT,
        created_at   TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    await pool.query(`ALTER TABLE pages ADD COLUMN IF NOT EXISTS netlify_url TEXT`);
    await pool.query(`ALTER TABLE pages ADD COLUMN IF NOT EXISTS netlify_id  TEXT`);
    console.log('✓ Database ready');
  } catch (err) {
    console.error('✗ Database init failed:', err.message);
  }
}
initDB();

app.use(express.json({ limit: '5mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ── Proxy Anthropic API ────────────────────────────────────────────────
app.post('/api/chat', async (req, res) => {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(500).json({ error: { message: 'ANTHROPIC_API_KEY not set in Railway.' } });
  const { model, max_tokens, system, messages } = req.body;
  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model, max_tokens, system, messages })
    });
    const data = await response.json();
    res.status(response.status).json(data);
  } catch (err) {
    res.status(500).json({ error: { message: 'Anthropic API error: ' + err.message } });
  }
});

// ── Test Netlify connection ────────────────────────────────────────────
app.get('/api/test-netlify', async (req, res) => {
  const token = process.env.NETLIFY_TOKEN;
  if (!token) return res.json({ ok: false, reason: 'NETLIFY_TOKEN not set in Railway variables' });
  try {
    const r = await fetch('https://api.netlify.com/api/v1/user', {
      headers: { 'Authorization': `Bearer ${token}` }
    });
    const data = await r.json();
    if (data.email) {
      return res.json({ ok: true, email: data.email });
    }
    res.json({ ok: false, reason: 'Invalid token — Netlify rejected it', detail: data });
  } catch (err) {
    res.json({ ok: false, reason: 'Could not reach Netlify API: ' + err.message });
  }
});

// ── Check status ───────────────────────────────────────────────────────
app.get('/api/status', (req, res) => {
  res.json({ netlify: !!process.env.NETLIFY_TOKEN, db: !!process.env.DATABASE_URL });
});

// ── Deploy to Netlify ──────────────────────────────────────────────────
async function deployToNetlify(html) {
  const token = process.env.NETLIFY_TOKEN;
  if (!token) {
    console.log('⚠ NETLIFY_TOKEN not set — skipping Netlify deploy');
    return null;
  }

  try {
    // Step 1: Create site with NO name — Netlify auto-generates a unique one
    // This avoids "name already taken" errors which cause silent failures
    console.log('Creating Netlify site...');
    const siteRes = await fetch('https://api.netlify.com/api/v1/sites', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`
      },
      body: JSON.stringify({}) // ← no name = Netlify picks a unique random one
    });

    if (!siteRes.ok) {
      const errText = await siteRes.text();
      console.error('✗ Netlify site creation failed:', siteRes.status, errText);
      return null;
    }

    const site = await siteRes.json();
    if (!site.id) {
      console.error('✗ Netlify returned no site id:', site);
      return null;
    }
    console.log('✓ Netlify site created:', site.subdomain);

    // Step 2: Zip the HTML and deploy
    console.log('Deploying to Netlify...');
    const zip = new JSZip();
    zip.file('index.html', html);
    const zipBuffer = await zip.generateAsync({ type: 'nodebuffer' });

    const deployRes = await fetch(`https://api.netlify.com/api/v1/sites/${site.id}/deploys`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/zip',
        'Authorization': `Bearer ${token}`
      },
      body: zipBuffer
    });

    if (!deployRes.ok) {
      const errText = await deployRes.text();
      console.error('✗ Netlify deploy failed:', deployRes.status, errText);
      return null;
    }

    const deploy = await deployRes.json();
    if (deploy.error_message) {
      console.error('✗ Netlify deploy error:', deploy.error_message);
      return null;
    }

    // Use subdomain URL — ssl_url may not be ready immediately
    const netlifyUrl = `https://${site.subdomain}.netlify.app`;
    console.log('✓ Deployed to Netlify:', netlifyUrl);
    return { url: netlifyUrl, id: site.id };

  } catch (err) {
    console.error('✗ Netlify exception:', err.message);
    return null;
  }
}

// ── Publish a webpage ──────────────────────────────────────────────────
app.post('/api/publish', async (req, res) => {
  const { html, slug } = req.body;
  if (!html || !slug) return res.status(400).json({ error: 'Missing html or slug' });

  const safeSlug = slug.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').substring(0, 60);
  const name = safeSlug.replace(/-[a-z0-9]{4,8}$/, '').replace(/-/g, ' ').trim();

  console.log(`Publishing page: ${safeSlug}`);

  // Deploy to Netlify
  const netlify = await deployToNetlify(html);

  try {
    await pool.query(
      `INSERT INTO pages (slug, name, html, netlify_url, netlify_id)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (slug) DO UPDATE SET html=$3, netlify_url=$4, netlify_id=$5, created_at=NOW()`,
      [safeSlug, name, html, netlify?.url || null, netlify?.id || null]
    );

    console.log(`✓ Page saved. Netlify: ${netlify?.url || 'not deployed'}`);
    res.json({
      url: '/pages/' + safeSlug,
      netlify_url: netlify?.url || null,
      netlify_error: netlify === null && !!process.env.NETLIFY_TOKEN ? 'Netlify deploy failed — check Railway logs' : null,
      slug: safeSlug
    });
  } catch (err) {
    console.error('✗ DB save failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Serve a page from DB ───────────────────────────────────────────────
app.get('/pages/:slug', async (req, res) => {
  try {
    const result = await pool.query('SELECT html FROM pages WHERE slug = $1', [req.params.slug]);
    if (!result.rows.length) return res.status(404).send('<html><body style="font-family:sans-serif;text-align:center;padding:4rem"><h1>Page not found</h1><p><a href="/">← Back</a></p></body></html>');
    res.setHeader('Content-Type', 'text/html');
    res.send(result.rows[0].html);
  } catch (err) {
    res.status(500).send('<h1>Error loading page</h1>');
  }
});

// ── List pages ─────────────────────────────────────────────────────────
app.get('/api/pages', async (req, res) => {
  try {
    const result = await pool.query('SELECT slug, name, netlify_url, created_at FROM pages ORDER BY created_at DESC');
    res.json({
      pages: result.rows.map(r => ({
        slug: r.slug,
        name: r.name,
        url: '/pages/' + r.slug,
        netlify_url: r.netlify_url,
        created: new Date(r.created_at).getTime()
      }))
    });
  } catch (err) {
    res.json({ pages: [] });
  }
});

// ── Delete a page ──────────────────────────────────────────────────────
app.delete('/api/pages/:slug', async (req, res) => {
  try {
    const result = await pool.query('SELECT netlify_id FROM pages WHERE slug=$1', [req.params.slug]);
    const netlifyId = result.rows[0]?.netlify_id;
    const token = process.env.NETLIFY_TOKEN;
    if (netlifyId && token) {
      await fetch(`https://api.netlify.com/api/v1/sites/${netlifyId}`, {
        method: 'DELETE',
        headers: { 'Authorization': `Bearer ${token}` }
      }).catch(() => {});
    }
    await pool.query('DELETE FROM pages WHERE slug=$1', [req.params.slug]);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => console.log(`AI Agent Network running on port ${PORT}`));
