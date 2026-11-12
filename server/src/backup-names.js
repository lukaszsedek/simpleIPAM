// Backup file naming, shared by local backups and the Drive retention logic.
const stamp = (d) => d.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, '').replace('T', '-');
export const backupName = (d = new Date()) => `ipam-${stamp(d)}.db`;
// also matches the short names written by earlier versions
export const isBackupName = (n) => /^ipam-(\d{8}-\d{6}|\d{4}-\d{2}-\d{2})\.db$/.test(n);
