export function findStaleOrderCacheRecords(cachedRecords = [], nextRecords = []) {
  const nextKeys = new Set(nextRecords.map(sourceKey_).filter(Boolean));

  return cachedRecords.filter(record => {
    const key = sourceKey_(record);
    return key && !nextKeys.has(key);
  });
}

function sourceKey_(record) {
  const source = String(record?.source_sheet_name || '').trim();
  const rowNumber = Number(record?.source_row_number);

  if (!source || !Number.isInteger(rowNumber) || rowNumber < 1) return '';
  return `${source}::${rowNumber}`;
}
