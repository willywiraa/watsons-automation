// Progress lines in the PRD's format (§27), e.g. "[12:31:04] [INFO] Login successful".
// Never log settings values (usernames, passwords).
// "ASK": the run is waiting for the person's answer (src/utils/ask.ts; the launcher reads it).

type Level = 'INFO' | 'WARN' | 'PASS' | 'ASK';

export function log(message: string, level: Level = 'INFO'): void {
  const time = new Date().toTimeString().slice(0, 8);
  console.log(`[${time}] [${level}] ${message}`);
}
