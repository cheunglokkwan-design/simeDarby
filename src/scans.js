// Local scan library. Blob data stays in IndexedDB, never in localStorage or JSON.
const DB_NAME = 'solar-drone-scans';
const STORE = 'scans';
export const MAX_SCAN_BYTES = 200 * 1024 * 1024;

function database() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE, { keyPath: 'id' });
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(new Error('Scan storage is unavailable. Allow site storage in this browser and try again.'));
    request.onblocked = () => reject(new Error('Close other scan windows, then try again.'));
  });
}

async function transact(mode, operation) {
  const db = await database();
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, mode);
      const request = operation(tx.objectStore(STORE));
      tx.oncomplete = () => resolve(request.result);
      tx.onerror = tx.onabort = () => reject(new Error(tx.error?.name === 'QuotaExceededError'
        ? 'There is not enough browser storage. Free some space or choose a smaller scan.'
        : 'The scan could not be saved or read. Check browser storage and try again.'));
    });
  } finally { db.close(); }
}

export const getLocalScan = (id) => transact('readonly', (store) => store.get(id));
export const saveLocalScan = (scan) => transact('readwrite', (store) => store.put(scan));
export const removeLocalScan = (id) => transact('readwrite', (store) => store.delete(id));

export async function localScanMetadata() {
  const scans = await transact('readonly', (store) => store.getAll());
  return Object.fromEntries(scans.map(({ file, ...scan }) => [scan.id, { ...scan, local: true }]));
}

export async function validateSplat(file) {
  if (!file?.size) throw new Error('Choose a non-empty Gaussian splat file.');
  const format = file.name.split('.').pop().toLowerCase();
  if (!['ply', 'splat', 'ksplat'].includes(format)) {
    throw new Error('Choose a .ply, .splat or .ksplat file. Process drone video into a Gaussian splat first.');
  }
  if (file.size > MAX_SCAN_BYTES) throw new Error('Choose a scan under 200 MB. Crop or compress this scan first.');
  if (format === 'ply') {
    const header = await file.slice(0, 65536).text();
    const end = header.indexOf('end_header');
    const properties = header.slice(0, end);
    if (!/^ply\r?\n/.test(header) || end < 0 || !/element vertex [1-9]\d*/.test(properties) ||
      !['opacity', 'scale_0', 'rot_0', 'f_dc_0'].every((key) => new RegExp(`property \\w+ ${key}(?:\\r?\\n)`).test(properties))) {
      throw new Error('This PLY is not a supported Gaussian splat. Export an uncompressed Gaussian PLY from your reconstruction tool.');
    }
  }
  if (format === 'splat' && file.size % 32 !== 0) throw new Error('This .splat file is incomplete or invalid. Export it again and retry.');
  if (format === 'ksplat' && file.size < 4096) throw new Error('This .ksplat file is incomplete. Export it again and retry.');
  return format;
}
