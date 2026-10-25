import { describe, expect, it } from 'vitest';
import { editorOptions } from './editorOptions';

describe('editor options', () => {
  it('keep the hover help and suggestions inside the window, whatever the editor asks for', () => {
    expect(editorOptions({ wordWrap: 'on' }, 14)).toEqual({ wordWrap: 'on', fontSize: 14, fixedOverflowWidgets: true });
    expect(editorOptions({ fixedOverflowWidgets: false, fontSize: 9 }, 16)).toMatchObject({ fixedOverflowWidgets: true, fontSize: 16 });
    expect(editorOptions(undefined, 12)).toEqual({ fontSize: 12, fixedOverflowWidgets: true });
  });
});
