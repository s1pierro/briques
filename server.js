import express from 'express';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { readdirSync, writeFileSync } from 'fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const app  = express();
const PORT = process.env.PORT || 8081;

app.use('/three',    express.static(join(__dirname, 'node_modules/three')));
app.use('/rapier',  express.static(join(__dirname, 'node_modules/@dimforge/rapier3d-compat')));
app.use('/eruda',   express.static(join(__dirname, 'node_modules/eruda')));
app.use('/manifold',express.static(join(__dirname, 'node_modules/manifold-3d')));
app.use('/pathtracer', express.static(join(__dirname, 'node_modules/three-gpu-pathtracer/build')));
app.use('/mesh-bvh',   express.static(join(__dirname, 'node_modules/three-mesh-bvh/build')));
app.use('/bank',   express.static(join(__dirname, 'bank')));
app.use(express.static(join(__dirname, 'public')));

app.use(express.json({ limit: '50mb' }));

app.put('/dynamics', (req, res) => {
  try {
    const filePath = join(__dirname, 'public', 'data', 'assembly-dynamics.json');
    writeFileSync(filePath, JSON.stringify(req.body, null, 2));
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.put('/mechanics', express.text({ limit: '2mb' }), (req, res) => {
  try {
    const filePath = join(__dirname, 'public', 'data', 'assembly-mechanics.toml');
    writeFileSync(filePath, req.body, 'utf8');
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.put('/bank/:name', (req, res) => {
  try {
    const name = decodeURIComponent(req.params.name);
    const filePath = join(__dirname, 'bank', name + '.json');
    writeFileSync(filePath, JSON.stringify(req.body, null, 2));
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/bank-index', (_req, res) => {
  const files = readdirSync(join(__dirname, 'bank'))
    .filter(f => f.endsWith('.json'))
    .map(f => f.replace(/\.json$/, ''));
  res.json(files);
});

app.listen(PORT, () => console.log(`rBang running at http://localhost:${PORT}`));
