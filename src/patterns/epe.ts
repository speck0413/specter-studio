// A pattern file (.epe) someone exported from their own controller: plain text holding the pattern's name, an
// id, its source code ("sources") and a small preview picture. Studio keeps the source under the pattern's name;
// it never shares or uploads it.

export interface ImportedPattern { name: string; id: string; source: string; preview?: string }

/** Reads a pattern file's text; throws an Error with a plain message when it is not one. */
export function parseEpe(text: string): ImportedPattern {
  let v: any;
  try { v = JSON.parse(text.replace(/^﻿/, '')); } catch { throw new Error('This file is not a pattern file (.epe): it could not be read.'); }
  if (!v || typeof v !== 'object') throw new Error('This file is not a pattern file (.epe).');
  const src = typeof v.sources === 'string' ? v.sources : v.sources && typeof v.sources.main === 'string' ? v.sources.main : typeof v.source === 'string' ? v.source : null;
  if (src === null) throw new Error('This pattern file has no pattern code in it.');
  if (src.length > 256 * 1024) throw new Error('This pattern is too big (more than 256 KB of code).');
  return { name: cleanPatternName(String(v.name ?? '')) || 'imported pattern', id: String(v.id ?? ''), source: src, preview: typeof v.preview === 'string' ? v.preview : undefined };
}

/** A name every file system takes: no / \ : * ? " < > |, no leading dot, at most 60 characters. */
export function cleanPatternName(name: string): string {
  return name.replace(/[/\\:*?"<>|\r\n\t\u0000-\u001f]+/g, ' ').replace(/\s+/g, ' ').replace(/^[.\s]+/, '').trim().slice(0, 60).trim();
}
