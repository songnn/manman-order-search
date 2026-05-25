import { createClient } from '@supabase/supabase-js';
import ws from 'ws';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

loadLocalEnv_();

if (!process.env.SUPABASE_URL) {
  throw new Error('SUPABASE_URL 환경변수가 없습니다. .env.local 위치와 값을 확인해주세요.');
}

if (!process.env.SUPABASE_SERVICE_ROLE_KEY) {
  throw new Error('SUPABASE_SERVICE_ROLE_KEY 환경변수가 없습니다. .env.local 위치와 값을 확인해주세요.');
}

export const supabaseAdmin = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  {
    auth: {
      persistSession: false
    },
    realtime: {
      transport: ws
    }
  }
);

function loadLocalEnv_() {
  const envPath = join(process.cwd(), '.env.local');

  if (!existsSync(envPath)) return;

  const content = readFileSync(envPath, 'utf8');

  content.split(/\r?\n/).forEach(line => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) return;

    const match = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!match) return;

    const [, key, rawValue] = match;

    if (process.env[key]) return;

    process.env[key] = unquoteEnvValue_(rawValue);
  });
}

function unquoteEnvValue_(value) {
  const trimmed = value.trim();

  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }

  return trimmed;
}