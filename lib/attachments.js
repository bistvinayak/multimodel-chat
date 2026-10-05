// File attachments: detection, PDF text extraction (once, at upload) and image descriptions
// (once, for models that cannot see images). Model requests reference files as
// attachment://<id>; the bytes are inlined only at send time, so the DB snapshot and
// Langfuse traces stay small.
import { readFile } from 'node:fs/promises';

export const LIMITS = { image: 10 * 1024 * 1024, pdf: 20 * 1024 * 1024, text: 2 * 1024 * 1024 };
export const MAX_PER_MESSAGE = 6;
export const MAX_IMAGES_PER_REQUEST = 8;
export const IMAGE_TOKENS = 1100; // rough per-image cost for budgeting

const TEXT_EXT = /\.(txt|md|markdown|csv|tsv|json|jsonl|xml|ya?ml|html?|css|js|mjs|cjs|jsx|ts|tsx|py|ipynb|java|kt|go|rb|rs|c|h|cc|cpp|hpp|cs|php|swift|scala|sql|sh|bash|zsh|ps1|r|lua|pl|dart|vue|svelte|log|ini|toml|cfg|conf|env\.example|gitignore|dockerfile|tex|rst|srt|vtt)$/i;

/** Identify by magic bytes (never trust the browser's content type). */
export function detect(buf, name) {
  const b = buf.subarray(0, 16);
  if (b[0] === 0x89 && b.toString('latin1', 1, 4) === 'PNG') return { kind: 'image', mime: 'image/png' };
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return { kind: 'image', mime: 'image/jpeg' };
  if (b.toString('latin1', 0, 4) === 'GIF8') return { kind: 'image', mime: 'image/gif' };
  if (b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP') return { kind: 'image', mime: 'image/webp' };
  if (b.toString('latin1', 0, 5) === '%PDF-') return { kind: 'pdf', mime: 'application/pdf' };
  if (TEXT_EXT.test(name) || /^[^.]+$/.test(name)) {
    if (buf.includes(0)) return null;                         // binary
    const text = new TextDecoder('utf-8', { fatal: false }).decode(buf);
    const bad = (text.match(/�/g) || []).length;
    if (bad > Math.max(5, text.length * 0.01)) return null;    // not really UTF-8 text
    return { kind: 'text', mime: 'text/plain', text };
  }
  return null;
}

export const safeName = (n) => String(n || 'file').replace(/[\\/\0\r\n"]/g, '_').slice(0, 140) || 'file';

/** Parse a PDF once with OpenRouter's free file parser; returns markdown text. */
export async function extractPdfText({ apiKey, model, filePath, filename }) {
  const b64 = (await readFile(filePath)).toString('base64');
  const r = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    signal: AbortSignal.timeout(120_000),
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json', 'HTTP-Referer': 'http://localhost', 'X-Title': 'Multi-Model Workspace' },
    body: JSON.stringify({
      model, max_tokens: 16,
      plugins: [{ id: 'file-parser', pdf: { engine: 'cloudflare-ai' } }],   // free engine; the default (mistral-ocr) is paid
      messages: [{ role: 'user', content: [{ type: 'text', text: 'Reply with OK.' }, { type: 'file', file: { filename, file_data: `data:application/pdf;base64,${b64}` } }] }],
    }),
  });
  const body = await r.json().catch(() => ({}));
  if (!r.ok || body.error) throw new Error(body.error?.message || `HTTP ${r.status}`);
  const ann = body.choices?.[0]?.message?.annotations?.find((a) => a.type === 'file');
  const parts = (ann?.file?.content || []).filter((p) => p.type === 'text').map((p) => p.text);
  let text = parts.filter((t) => !/^<\/?file\b/.test(t.trim())).join('\n').trim();
  text = text.replace(/^#\s+document\.pdf\s*/i, '').replace(/## Metadata[\s\S]*?(?=## Contents)/, '').replace(/^## Contents\s*/m, '').trim();
  if (!text) throw new Error('No text could be extracted. The PDF may be scanned images only.');
  return text;
}

/** One detailed description, for models that cannot see images. */
export async function describeImage({ apiKey, model, filePath, mime }) {
  const b64 = (await readFile(filePath)).toString('base64');
  const r = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    signal: AbortSignal.timeout(90_000),
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json', 'HTTP-Referer': 'http://localhost', 'X-Title': 'Multi-Model Workspace' },
    body: JSON.stringify({
      model, max_tokens: 2500,
      messages: [
        { role: 'system', content: 'You describe images for another AI model that cannot see them. Be precise and complete: what the image is (screenshot, chart, photo, diagram, document), every piece of visible text transcribed verbatim, numbers and labels in charts or tables, layout, and any notable details. Do not speculate beyond what is visible. Plain text, no preamble.' },
        { role: 'user', content: [{ type: 'text', text: 'Describe this image.' }, { type: 'image_url', image_url: { url: `data:${mime};base64,${b64}` } }] },
      ],
    }),
  });
  const body = await r.json().catch(() => ({}));
  if (!r.ok || body.error) throw new Error(body.error?.message || `HTTP ${r.status}`);
  const text = (body.choices?.[0]?.message?.content || '').trim();
  if (text.length < 20) throw new Error('Empty description');
  return text;
}

/** Replace attachment://<id> references with data URLs right before sending. */
export async function materialize(messages, lookup) {
  const cache = new Map();
  const load = async (id) => {
    if (!cache.has(id)) { const a = lookup(id); if (!a) throw new Error('Attachment missing'); cache.set(id, { a, b64: (await readFile(a.path)).toString('base64') }); }
    return cache.get(id);
  };
  const out = [];
  for (const m of messages) {
    if (!Array.isArray(m.content)) { out.push(m); continue; }
    const parts = [];
    for (const p of m.content) {
      if (p.type === 'image_url' && p.image_url.url.startsWith('attachment://')) {
        const { a, b64 } = await load(p.image_url.url.slice(13));
        parts.push({ type: 'image_url', image_url: { url: `data:${a.mime};base64,${b64}` } });
      } else if (p.type === 'file' && String(p.file.file_data).startsWith('attachment://')) {
        const { a, b64 } = await load(p.file.file_data.slice(13));
        parts.push({ type: 'file', file: { filename: a.name, file_data: `data:${a.mime};base64,${b64}` } });
      } else parts.push(p);
    }
    out.push({ ...m, content: parts });
  }
  return out;
}
