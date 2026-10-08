import { extname } from 'node:path';

const BY_EXT: Record<string, string> = {
  '.json': 'application/json',
  '.txt': 'text/plain; charset=utf-8',
  '.log': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.diff': 'text/x-diff; charset=utf-8',
  '.patch': 'text/x-diff; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.pdf': 'application/pdf',
};

export const mediaTypeFor = (path: string): string => BY_EXT[extname(path).toLowerCase()] ?? 'application/octet-stream';

const TEXTUAL_APPLICATION = new Set([
  'application/json',
  'application/xml',
  'application/yaml',
  'application/x-yaml',
  'application/javascript',
  'application/x-ndjson',
]);

export const isTextual = (mediaType: string): boolean => {
  const essence = (mediaType.split(';')[0] ?? '').trim().toLowerCase();
  return essence.startsWith('text/') || TEXTUAL_APPLICATION.has(essence) || /\+(json|xml|yaml)$/.test(essence);
};
