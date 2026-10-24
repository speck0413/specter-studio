// Feeds the run tracker (runs.ts) from every board, whatever page is open: `run` events and states of boards
// with a direct session, and of boards that report over Studio's MQTT server (a board that does both is followed
// through its direct session only, as DashboardWork does). Also reads the extensions' icons. Mounted once (App).
import { useEffect, useRef } from 'react';
import { onEvent } from '../api';
import { useStore } from '../store';
import { topicLabel } from '../dashboard/events';
import { onPluginsChanged } from '../pluginsChanged';
import { runs } from './runs';
import { loadExtIcons } from './icons';

export default function PropRunsWork() {
  const { boards } = useStore();
  const boardsRef = useRef(boards);
  boardsRef.current = boards;
  useEffect(() => { void loadExtIcons(); return onPluginsChanged(() => void loadExtIcons()); }, []);
  useEffect(() => {
    const direct = (label: string) => Object.values(boardsRef.current).some((b) => topicLabel(b.info?.name) === label);
    return onEvent((e: any) => {
      const now = Date.now();
      if (e.kind === 'board') {
        const b = boardsRef.current[e.key];
        if (!b) return;
        const label = topicLabel(b.info?.name || e.key);
        if (e.msg?.event === 'run') runs.runEvent(label, e.msg.data, now);
        else if (e.msg?.event === 'state') runs.noteState(label, e.msg.data, now);
      } else if (e.kind === 'online') {
        const b = boardsRef.current[e.key];
        if (b && !e.online) runs.forget(topicLabel(b.info?.name || e.key));
      } else if (e.kind === 'fleet') {
        const fb = e.board || {};
        const label = topicLabel(fb.name || fb.state?.name || fb.key);
        if (direct(label)) return;
        if (fb.online === false) runs.forget(label);
        else if (fb.state) runs.noteState(label, fb.state, now);
      } else if (e.kind === 'fleet_event') {
        const label = topicLabel(e.name);
        if (!direct(label) && e.msg?.event === 'run') runs.runEvent(label, e.msg.data, now);
      }
    });
  }, []);
  return null;
}
