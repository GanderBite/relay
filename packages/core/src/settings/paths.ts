import { homedir } from 'node:os';
import { join } from 'node:path';

export function globalSettingsPath(): string {
  return join(homedir(), '.relay', 'settings.json');
}

export function flowSettingsPath(flowDir: string): string {
  return join(flowDir, 'settings.json');
}
