import { stripVTControlCharacters } from 'node:util';
import type { DaemonLogFields } from './index.js';

/** Plain UTF-8 for both saved logs and service output. Keep every line attributable. */
export function formatDaemonLog(timestamp: string, level: string, message: string, fields: DaemonLogFields): string {
  const clean = (value: string): string => stripVTControlCharacters(value).replace(/\r\n?/g, '\n');
  const valueText = (value: unknown): string => {
    if (typeof value === 'string') return clean(value);
    if (Array.isArray(value)) return value.map(valueText).join(', ');
    if (value && typeof value === 'object') {
      return Object.entries(value).map(([key, item]) => `${key}: ${valueText(item)}`).join('; ');
    }
    return String(value);
  };
  const context = [fields.agent, fields.runId ? `run ${fields.runId}` : undefined,
    level === 'output' ? fields.stream : undefined].filter(Boolean).join(' · ');
  const prefix = `${timestamp} ${level.toUpperCase().padEnd(6)}${context ? ` [${clean(context).replace(/\n/g, ' ')}]` : ''}`;
  const body = level === 'output' ? fields.text ?? '' : message;
  const lines = clean(body).replace(/\n$/, '').split('\n').map(line => `${prefix} ${line}`);
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined || ['agent', 'runId', 'stream', 'sequence'].includes(key)) continue;
    if (key === 'text' && level === 'output') continue;
    const label = key.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase();
    lines.push(...valueText(value).split('\n').map(line => `${prefix}   ${label}: ${line}`));
  }
  return `${lines.join('\n')}\n`;
}
