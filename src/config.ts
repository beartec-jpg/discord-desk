import 'dotenv/config';

export function isMock(): boolean {
  const v = (process.env.XAI_MOCK || '').trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'yes';
}

export const config = {
  /** xAI key, or the sentinel 'mock' when XAI_MOCK=1 (offline mode). */
  xaiKey(): string {
    if (isMock()) return 'mock';
    return (process.env.XAI_API_KEY || '').trim();
  },
  port: Number(process.env.PORT || 3000),
  host: process.env.HOST || '127.0.0.1',
  scheduleBtc: process.env.DESK_SCHEDULE_BTC ?? '45 5 * * *',
  scheduleXrp: process.env.DESK_SCHEDULE_XRP ?? '50 5 * * *',
  scheduleTz: process.env.DESK_SCHEDULE_TZ || 'UTC',
  dataDir: process.env.DATA_DIR || './data',
};

/** bundled (default when TRACKER_URL is unset) | external (TRACKER_URL set) | off */
export function trackerMode(): 'bundled' | 'external' | 'off' {
  const m = (process.env.TRACKER_MODE || '').trim().toLowerCase();
  if (m === 'off' || m === '0' || m === 'none') return 'off';
  if ((process.env.TRACKER_URL || '').trim()) return 'external';
  if (m === 'external') return 'off'; // external requested but no URL
  return 'bundled';
}
