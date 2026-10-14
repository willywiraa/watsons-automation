// Progress lines in the PRD's format (§27), e.g. "[12:31:04] [INFO] Login successful".
// Never log settings values (usernames, passwords).

type Level = 'INFO' | 'WARN' | 'PASS';

export function log(message: string, level: Level = 'INFO'): void {
  const time = new Date().toTimeString().slice(0, 8);
  console.log(`[${time}] [${level}] ${message}`);
}
