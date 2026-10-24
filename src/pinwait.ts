// The page password's wait after a wrong try (newer firmware): never a second question for a right password.

/** After a wrong page password newer firmware makes the next try wait ("wrong page password: wait 2 s before the
 * next try"): the try is sent again after that wait instead of asking the person again. */
export function pinWaitMs(r: any): number {
  const m = r?.ok === false && r.error?.code === 'pin' ? /wait (\d+(?:\.\d+)?) ?s\b/.exec(String(r.error?.message || '')) : null;
  return m ? Math.min(31, Number(m[1])) * 1000 + 100 : 0;
}
export async function pinBackoff<T>(send: () => Promise<T>, sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))): Promise<T> {
  let r = await send();
  for (let i = 0; i < 3; i++) {
    const ms = pinWaitMs(r);
    if (!ms) break;
    await sleep(ms);
    r = await send();
  }
  return r;
}

