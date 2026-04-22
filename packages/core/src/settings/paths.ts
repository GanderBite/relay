import { homedir } from 'node:os';
import { join } from 'node:path';

export function globalSettingsPath(): string {
  return join(homedir(), '.relay', 'settings.json');
}

export function raceSettingsPath(raceDir: string): string {
  return join(raceDir, 'settings.json');
}
