export const $ = s => document.querySelector(s);
export const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
export const lerp = (a, b, t) => a + (b - a) * t;
export const rand = (a, b) => a + Math.random() * (b - a);
export const choice = a => a[Math.floor(Math.random() * a.length)];
export const mtof = m => 440 * Math.pow(2, (m - 69) / 12);
