import './style.css';
import * as ui from './ui.js';
import * as engine from './engine.js';
import {state} from './state.js';
import {STYLES} from './styles.js';

ui.init();

/* debug/testing handle (same shape the single-file build exposed) */
window.__pb = {
  state,
  conductor: engine.conductor,
  ac: engine.getAC,
  analyser: engine.getAnalyser,
  rms: ui.rms,
  styles: STYLES,
  inst: engine.INSTRUMENTS,
  samples: engine.samples,
};

/* PWA: register the service worker only in production builds */
if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  });
}
