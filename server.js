const express = require('express');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 8080;
const PAGES_DIR = path.join(__dirname, 'pages');

// Create pages directory on startup if it doesn't exist
if (!fs.existsSync(PAGES_DIR)) fs.mkdirSync(PAGES_DIR);

app.use(express.json({ limit: '5mb' }));
app.use(express.static(path.join(__dirname, 'public')));
app.use('/pages', express.static(PAGES_DIR));

// ── Proxy Anthropic API calls (keeps API key server-side) ──────────────
app.post('/api/chat', async (req, res) => {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: { message: 'ANTHROPIC_API_KEY is not set in Railway environment variables.' } });
  }
  const { model, max_tokens, system, messages } = req.body;
  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({ model, max_tokens, system, messages })
    });
    const data = await response.json();
    res.status(response.status).json(data);
  } catch (err) {
    res.status(500).json({ error: { message: 'Failed to reach Anthropic API: ' + err.message } });
  }
});

// ── Publish a webpage ──────────────────────────────────────────────────
app.post('/api/publish', (req, res) => {
  const { html, slug } = req.body;
  if (!html || !slug) return res.status(400).json({ error: 'Missing html or slug' });

  const safeSlug = slug.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').substring(0, 60);
  const filename = safeSlug + '.html';
  const filepath = path.join(PAGES_DIR, filename);

  try {
    fs.writeFileSync(filepath, html, 'utf8');
    const url = '/pages/' + filename;
    console.log('Published page:', url);
    res.json({ url, slug: safeSlug });
  } catch (err) {
    console.error('Publish error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── List all published pages ───────────────────────────────────────────
app.get('/api/pages', (req, res) => {
  try {
    const files = fs.readdirSync(PAGES_DIR)
      .filter(f => f.endsWith('.html'))
      .map(f => ({
        name: f.replace('.html', '').replace(/-/g, ' '),
        slug: f.replace('.html', ''),
        url: '/pages/' + f,
        created: fs.statSync(path.join(PAGES_DIR, f)).mtimeMs
      }))
      .sort((a, b) => b.created - a.created);
    res.json({ pages: files });
  } catch (err) {
    res.json({ pages: [] });
  }
});

// ── Delete a published page ────────────────────────────────────────────
app.delete('/api/pages/:slug', (req, res) => {
  const filepath = path.join(PAGES_DIR, req.params.slug + '.html');
  try {
    if (fs.existsSync(filepath)) fs.unlinkSync(filepath);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Catch-all
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`AI Agent Network running on port ${PORT}`);
});
