// Runs the roof-shading raycast (src/shading.js) off the main thread.
import { computeShading } from './shading.js';

self.onmessage = ({ data }) => {
  const { lat, lon, items } = data; // items: [{xy, bbox, height, centroid, skip}]
  const result = computeShading(items, lat, lon, (progress) => self.postMessage({ progress }));
  self.postMessage({ done: true, result }, [result.buffer]);
};
