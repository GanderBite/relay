export function logStructured(
  event: string,
  fields: Record<string, string | number | undefined>,
): void {
  const iso = new Date().toISOString();
  const cols = Object.entries(fields)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => `${k}=${String(v)}`);
  process.stderr.write(`${iso} info  ${event.padEnd(12)} ${cols.join('  ')}\n`);
}

export function fmtElapsedSec(startedAt: string): string {
  const s = (Date.now() - new Date(startedAt).getTime()) / 1000;
  return s < 10 ? `${s.toFixed(1)}s` : `${Math.round(s)}s`;
}

export function fmtHHMM(startedAt: string): string {
  const secs = Math.floor((Date.now() - new Date(startedAt).getTime()) / 1000);
  const hh = String(Math.floor(secs / 3600)).padStart(2, '0');
  const mm = String(Math.floor((secs % 3600) / 60)).padStart(2, '0');
  return `${hh}:${mm}`;
}
