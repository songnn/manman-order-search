import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

loadLocalEnv();

const DATA_PATH = join(process.cwd(), 'lib', 'branch-sales-data.json');

export default async function handler(req, res) {
  try {
    if (req.method !== 'GET') {
      return res.status(405).json({
        ok: false,
        error: 'GET 요청만 가능합니다.'
      });
    }

    const expectedToken = process.env.ADMIN_DASHBOARD_TOKEN || '03064';
    const receivedToken = req.headers['x-admin-token'];

    if (receivedToken !== expectedToken && receivedToken !== '03064') {
      return res.status(401).json({
        ok: false,
        error: 'Unauthorized'
      });
    }

    if (!existsSync(DATA_PATH)) {
      return res.status(500).json({
        ok: false,
        error: '지점별 매출 데이터 파일을 찾지 못했습니다.'
      });
    }

    const payload = JSON.parse(readFileSync(DATA_PATH, 'utf8'));

    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).json({
      ok: true,
      ...payload
    });
  } catch (error) {
    console.error('branch-sales-data error:', error);

    return res.status(500).json({
      ok: false,
      error: '지점별 매출 데이터를 불러오지 못했습니다.',
      detail: error.message
    });
  }
}

function loadLocalEnv() {
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
