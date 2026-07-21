const HARD_GUARD_REASON_CODES = new Set([
  'duplicate_source_rows',
  'spreadsheet_errors'
]);

export function decideOrderCacheSync({
  guard = {},
  manualCleanupFreeze = false,
  guardDisabled = false
} = {}) {
  const reasons = Array.isArray(guard.reasons) ? guard.reasons : [];
  const hardReasons = guardDisabled
    ? []
    : reasons.filter(reason => HARD_GUARD_REASON_CODES.has(reason?.code));

  if (hardReasons.length) {
    return {
      mode: 'rejected',
      allowUpsert: false,
      allowStaleDeletion: false,
      hardReasons
    };
  }

  const degraded = !guardDisabled && guard.ok === false;
  const cleanupFrozen = Boolean(manualCleanupFreeze || degraded);

  return {
    mode: cleanupFrozen ? 'continuous-safe' : 'full',
    allowUpsert: true,
    allowStaleDeletion: !cleanupFrozen,
    hardReasons: []
  };
}

