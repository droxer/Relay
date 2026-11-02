/** Local Windows commands are Node programs; guest and POSIX commands remain Bash scripts. */
export function nativeWindowsExecution(platform = process.platform): boolean {
  return platform === 'win32' && process.env.RELAY_RUN_AS_CURRENT_USER === '1';
}

export function commandExecution(script: string): { command: string; args: string[] } {
  return nativeWindowsExecution()
    ? { command: 'relay-native', args: [script] }
    : { command: 'bash', args: ['-c', script] };
}

export function chainCommands(commands: string[]): string {
  return commands.filter(Boolean).join(nativeWindowsExecution() ? ';\n' : ' && ');
}

export function environmentCommand(key: string, value: string, quote: (value: string) => string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) throw new Error('Invalid environment variable name.');
  return nativeWindowsExecution() ? `process.env[${JSON.stringify(key)}] = ${JSON.stringify(value)}` : `export ${key}=${quote(value)}`;
}
