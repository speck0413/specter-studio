// Monaco, uncontrolled: the editor owns its text while you type (a controlled editor drops fast keystrokes);
// a change from outside (the blocks, a reload) is pushed in only when it differs, as one undoable edit.
import { useEffect, useRef } from 'react';
import Editor, { OnMount } from '@monaco-editor/react';
import { useTheme } from '@mui/material';
import { defineMonacoTheme, editorFontSize, monacoThemeName } from '../theme';
import { runSave } from '../shell/save';
import { editorOptions } from './editorOptions';

export default function CodeEditor({ value, onChange, language, dark, options, onMount }: {
  value: string; onChange: (v: string) => void; language: string; dark: boolean; options?: Record<string, unknown>; onMount?: OnMount;
}) {
  const ed = useRef<any>(null);
  // the app's theme and text size (dark stays for callers; the colours come from the theme's tokens)
  void dark;
  const theme = useTheme();
  const fontSize = editorFontSize(theme);
  const monacoRef = useRef<any>(null);
  useEffect(() => { if (monacoRef.current) { defineMonacoTheme(monacoRef.current, theme); monacoRef.current.editor.setTheme(monacoThemeName(theme)); } }, [theme]);
  useEffect(() => { ed.current?.updateOptions({ fontSize }); }, [fontSize]);
  const change = useRef(onChange);
  change.current = onChange;
  useEffect(() => {
    const e = ed.current;
    // while someone types here, this editor is the source: a late echo from elsewhere must not overwrite it
    if (!e || e.getValue() === value || (e.hasTextFocus() && !e.getRawOptions().readOnly)) return;
    const model = e.getModel();
    // on the model: an editor's own edit call does nothing while it is read-only (blocks mode)
    model.pushStackElement();
    model.pushEditOperations([], [{ range: model.getFullModelRange(), text: value }], () => null);
    model.pushStackElement();
  }, [value]);
  return (
    <Editor language={language} theme={monacoThemeName(theme)} defaultValue={value}
      beforeMount={(m) => { monacoRef.current = m; defineMonacoTheme(m, theme); }}
      onChange={(v) => change.current(v ?? '')}
      onMount={(e, m) => {
        ed.current = e; if (e.getValue() !== value) e.setValue(value);
        // Ctrl+S / ⌘S inside the editor: Save (the window's shortcut normally takes it first; this is the editor's own
        // binding for when it gets the key, so it never types or does nothing)
        e.addCommand(m.KeyMod.CtrlCmd | m.KeyCode.KeyS, () => { runSave(); });
        onMount?.(e, m);
      }}
      options={editorOptions(options, fontSize)} />
  );
}
