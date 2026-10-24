// Fills the Dashboard's feed from every board, whatever page is open: the events of boards with a direct session
// (WebSocket, USB, practice boards) and of boards that report to Studio's MQTT server, online / offline changes,
// and the last run each board's state reports. Writes the feed to the library, one file per night. Mounted once
// (App).
import { useEffect, useRef } from 'react';
import { call, onEvent } from '../api';
import { useStore } from '../store';
import { feed, FEED_FLUSH_MS } from './feed';
import { countsOf, fromBoardMsg, onlineEvent, topicLabel, type FeedEvent } from './events';
import { NIGHT_GAP_MS } from './nights';

export default function DashboardWork() {
  const { boards, prefs } = useStore();
  const boardsRef = useRef(boards);
  boardsRef.current = boards;
  // boards that report over MQTT: their name and whether they were online, by key (prefix/name)
  const fleet = useRef<Record<string, { name: string; online: boolean }>>({});

  // the night files: in the library's hidden folder; the newest one tells which night is running
  useEffect(() => {
    const folder = prefs.workspace;
    if (!folder) { feed.writer = null; return; }
    feed.writer = (night: string, events: FeedEvent[]) => call('nights_append', { folder, night, events });
    void (async () => {
      const list: any[] = await call('nights_list', { folder }).catch(() => []);
      if (!list.length || feed.cursor) return;
      const evs: FeedEvent[] = await call('nights_read', { folder, night: list[0].night }).catch(() => []);
      const runs = evs.filter((e) => e.type === 'run');
      const last = runs[runs.length - 1];
      if (last && Date.now() - last.t < NIGHT_GAP_MS && !feed.cursor) feed.cursor = { night: list[0].night, lastRun: last.t };
    })();
    const t = setInterval(() => void feed.flush(), FEED_FLUSH_MS);
    const away = () => void feed.flush();
    window.addEventListener('beforeunload', away);
    return () => { clearInterval(t); window.removeEventListener('beforeunload', away); void feed.flush(); };
  }, [prefs.workspace]);

  // a direct board by its name's topic label (a board both connected and reporting over MQTT is shown once)
  const directLabel = (label: string) => Object.values(boardsRef.current).some((b) => topicLabel(b.info?.name) === label);

  useEffect(() => onEvent((e: any) => {
    const now = Date.now();
    if (e.kind === 'board') {
      const b = boardsRef.current[e.key];
      if (!b) return;
      const name = b.info?.name || e.key;
      const ev = fromBoardMsg(name, e.msg, now, !countsOf(b.state), 'direct');
      if (ev) feed.add(ev, topicLabel(name), typeof e.msg?.data?.uptime_ms === 'number' ? e.msg.data.uptime_ms : undefined);
    } else if (e.kind === 'online') {
      const b = boardsRef.current[e.key];
      if (b && b.online !== e.online) feed.add(onlineEvent(b.info?.name || e.key, e.online, now));
    } else if (e.kind === 'fleet') {
      const fb = e.board || {};
      const name = fb.state?.name || fb.name || fb.key;
      const label = topicLabel(fb.name || name);
      const was = fleet.current[fb.key];
      fleet.current[fb.key] = { name, online: !!fb.online };
      if (!directLabel(label)) {
        if (was ? was.online !== !!fb.online : fb.online) feed.add(onlineEvent(name, !!fb.online, now, 'mqtt'));
        if (fb.state) feed.noteState(label, fb.state, now);
      }
    } else if (e.kind === 'fleet_event') {
      const label = topicLabel(e.name);
      if (directLabel(label)) return; // its direct session reports the same events
      const name = fleet.current[e.key]?.name || e.name;
      const ev = fromBoardMsg(name, e.msg, now, false, 'mqtt');
      if (ev) feed.add(ev, label, typeof e.msg?.data?.uptime_ms === 'number' ? e.msg.data.uptime_ms : undefined);
    }
  }), []); // eslint-disable-line react-hooks/exhaustive-deps

  // the last run a board's state reports (a run before Studio was listening)
  useEffect(() => {
    const now = Date.now();
    for (const b of Object.values(boards)) if (b.state && b.info?.name) feed.noteState(topicLabel(b.info.name), b.state, now);
  }, [boards]);
  return null;
}
