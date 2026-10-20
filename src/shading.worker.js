// Web Worker wrapper around the shared shading raycaster.
import { computeShading } from './shading.js';

self.onmessage = ({ data }) => {
  const { lat, lon, items } = data;
  const result = computeShading(lat, lon, items, (progress) => self.postMessage({ progress }));
  self.postMessage({ done: true, result }, [result.buffer]);
};
