import { describe, expect, it } from 'vitest';
import { boardScriptDrafts, closeQuestion, dropAll, sketchDrafts, unsavedBoardScripts, unsavedSketches, dropDraft, getDraft, moveDraft, onCloseRequest, setDraft, unsavedNames, unsavedSettings, unsavedSettingsBoards } from './drafts';

describe('unsaved effect edits', () => {
  it('keeps a changed text and forgets it once it matches the saved one', () => {
    setDraft('fog', 'effect fog:\n  rly1 = on\n', 'effect fog:\n');
    expect(getDraft('fog')).toBe('effect fog:\n  rly1 = on\n');
    expect(unsavedNames()).toContain('fog');
    setDraft('fog', 'effect fog:\n', 'effect fog:\n');
    expect(getDraft('fog')).toBeUndefined();
  });
  it('follows a rename and is dropped after a delete', () => {
    setDraft('a', 'x', 'y');
    moveDraft('a', 'b');
    expect(getDraft('a')).toBeUndefined();
    expect(getDraft('b')).toBe('x');
    dropDraft('b');
    expect(unsavedNames()).not.toContain('b');
  });
});

describe('closing the desktop window', () => {
  it('asks only when something is unsaved, naming it', () => {
    expect(closeQuestion([], [])).toBeNull();
    expect(closeQuestion(['fog'], ['Front door'])!.text).toBe('You changed the effect “fog” and the settings of Front door and did not save. Closing Specter Studio loses those changes.');
    unsavedSettings.set('sim:1', { name: 'x' });
    expect(unsavedSettingsBoards()).toEqual(['sim:1']);
    unsavedSettings.clear();
  });
  it('an effect script edited on a board page and not sent or saved counts too', () => {
    expect(closeQuestion([], [], [], [], ['Porch'])!.text).toBe('You changed the effect script on Porch and did not save. Closing Specter Studio loses those changes.');
    boardScriptDrafts.set('sim:1', { text: 'a', base: 'b' });
    expect(unsavedBoardScripts()).toEqual(['sim:1']);
    dropAll();
    expect(unsavedBoardScripts()).toEqual([]);
  });
  it('an unsaved firmware sketch counts too (it was lost silently before)', () => {
    expect(closeQuestion([], [], ['my lamp'])!.text).toBe('You changed the firmware “my lamp” and did not save. Closing Specter Studio loses those changes.');
    sketchDrafts.set('my lamp', { text: 'x', blocks: null, saved: '', blocksSaved: '' });
    expect(unsavedSketches()).toEqual(['my lamp']);
    dropAll();
    expect(unsavedSketches()).toEqual([]);
  });
  it('work in progress (a firmware update, an upload) asks too, saying what would be cut off', () => {
    const q = closeQuestion([], [], [], ['Porch: updating firmware'])!;
    expect(q.title).toBe('Close while Studio is still working?');
    expect(q.text).toContain('Porch: updating firmware');
    expect(q.text).toContain('without working firmware');
    expect(closeQuestion(['fog'], [], [], ['Porch: sending “x”'])!.text).toContain('the effect “fog”');
  });
  it('closes at once when nothing is unsaved, else only after yes', async () => {
    const run = async (question: any, answer: boolean) => {
      let prevented = false, closed = false, asked = false;
      await onCloseRequest({ preventDefault: () => { prevented = true; } }, question,
        async () => { asked = true; return answer; }, async () => { closed = true; });
      return { prevented, closed, asked };
    };
    expect(await run(null, false)).toEqual({ prevented: false, closed: false, asked: false });
    const q = closeQuestion(['fog'], []);
    expect(await run(q, false)).toEqual({ prevented: true, closed: false, asked: true });
    expect(await run(q, true)).toEqual({ prevented: true, closed: true, asked: true });
  });
});
