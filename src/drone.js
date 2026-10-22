const API = `${import.meta.env.BASE_URL}api/drone`;
export const VIDEO_EXTENSIONS = ['mp4', 'mov', 'm4v', 'webm'];

async function responseJSON(response) {
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.detail || data.message || 'The drone processor could not be reached. Try again when the worker is available.');
  return data;
}
export const droneHealth = () => fetch(`${API}/health`, { signal: AbortSignal.timeout(10000) }).then(responseJSON);
export const droneJob = (id) => fetch(`${API}/jobs/${encodeURIComponent(id)}`, { signal: AbortSignal.timeout(15000) }).then(responseJSON);

export function uploadDroneVideo(file, siteId, onProgress) {
  return new Promise((resolve, reject) => {
    const request = new XMLHttpRequest();
    request.open('POST', `${API}/jobs`);
    request.responseType = 'json';
    request.timeout = 20 * 60 * 1000;
    request.upload.onprogress = (e) => { if (e.lengthComputable) onProgress(Math.round(e.loaded / e.total * 100)); };
    request.onload = () => request.status >= 200 && request.status < 300 ? resolve(request.response)
      : reject(new Error(request.response?.detail || 'Upload failed. Check the worker connection and try again.'));
    request.onerror = request.ontimeout = () => reject(new Error('Upload interrupted. Check your connection and retry.'));
    const form = new FormData();
    form.append('site_id', siteId);
    form.append('video', file);
    request.send(form);
  });
}

export async function downloadDroneScan(id) {
  const response = await fetch(`${API}/jobs/${encodeURIComponent(id)}/scan`);
  if (!response.ok) await responseJSON(response);
  const blob = await response.blob();
  return new File([blob], `drone-${id}.ply`, { type: 'application/octet-stream' });
}
