import { useSyncExternalStore } from 'react';
import { english } from './english.js';

export type Language = 'es' | 'en';
const storageKey = 'nexo-language';
const listeners = new Set<() => void>();
const spanish = Object.fromEntries(Object.entries(english).map(([es, en]) => [en, es]));
const readLanguage = (): Language => {
  try { return localStorage.getItem(storageKey) === 'en' ? 'en' : 'es'; }
  catch { return 'es'; }
};
let language: Language = readLanguage();
export const getLanguage = () => language;
export const getLocale = () => language === 'en' ? 'en-US' : 'es-AR';

function applyLanguage() {
  if (typeof document !== 'undefined') document.documentElement.lang = language;
}
applyLanguage();

export function setLanguage(next: Language) {
  if (next !== 'es' && next !== 'en') return;
  if (next === language) return;
  language = next;
  try { localStorage.setItem(storageKey, next); } catch { /* Apply in memory when storage is unavailable. */ }
  applyLanguage();
  listeners.forEach(listener => listener());
}

if (typeof window !== 'undefined') window.addEventListener('storage', event => {
  if (event.key !== storageKey && event.key !== null) return;
  const next = readLanguage();
  if (next === language) return;
  language = next;
  applyLanguage();
  listeners.forEach(listener => listener());
});

const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
export function useLanguage() {
  return useSyncExternalStore(subscribe, getLanguage, () => 'es' as const);
}

/** Translate interface copy only. Patient names, clinical notes and chat history stay verbatim. */
export function t(source: string, values: readonly unknown[] = []): string {
  const template = language === 'en' ? english[source] ?? source : spanish[source] ?? source;
  return template.replace(/\{(\d+)\}/g, (match, index: string) => {
    const value = values[Number(index)];
    return value === undefined || value === null ? match : String(value);
  });
}
