// Monaco from the local package (never a CDN: the desktop app works offline), with the effect-script language.
import * as monaco from 'monaco-editor';
import EditorWorker from 'monaco-editor/editor/editor.worker.js?worker';
import { loader } from '@monaco-editor/react';
import { registerEffectLanguage } from './language';

let done = false;
export function setupMonaco() {
  if (done) return;
  done = true;
  // only plain editor work happens here (effect scripts and C++ have no language worker)
  (self as any).MonacoEnvironment = { getWorker: () => new EditorWorker() };
  loader.config({ monaco });
  registerEffectLanguage(monaco);
}
