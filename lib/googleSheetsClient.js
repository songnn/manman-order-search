import { google } from 'googleapis';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

loadLocalEnv();

export async function getSheetsClient() {
  if (!process.env.GOOGLE_CLIENT_EMAIL) {
    throw new Error('GOOGLE_CLIENT_EMAIL 환경변수가 없습니다.');
  }

  if (!process.env.GOOGLE_PRIVATE_KEY) {
    throw new Error('GOOGLE_PRIVATE_KEY 환경변수가 없습니다.');
  }

  if (!process.env.SPREADSHEET_ID) {
    throw new Error('SPREADSHEET_ID 환경변수가 없습니다.');
  }

  const auth = new google.auth.GoogleAuth({
    credentials: {
      client_email: process.env.GOOGLE_CLIENT_EMAIL,
      private_key: process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n')
    },
    scopes: ['https://www.googleapis.com/auth/spreadsheets']
  });

  return google.sheets({ version: 'v4', auth });
}

export function getSpreadsheetId() {
  if (!process.env.SPREADSHEET_ID) {
    throw new Error('SPREADSHEET_ID 환경변수가 없습니다.');
  }

  return process.env.SPREADSHEET_ID;
}

export function loadLocalEnv() {
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

    process.env[key] = unquoteEnvValue(rawValue);
  });
}

function unquoteEnvValue(value) {
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }

  return value;
}
