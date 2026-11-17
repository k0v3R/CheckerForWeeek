/**
 * Оффскрин-документ Checker for Weeek: воспроизводит собственный звук
 * уведомления (sounds/notification.wav — синтезирован с нуля) при появлении
 * новых уведомлений.
 */

chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type !== 'weeek:play-sound') return undefined;
  try {
    const audio = new Audio(chrome.runtime.getURL('sounds/notification.wav'));
    audio.volume = msg.volume ?? 0.4; // тихий сигнал
    audio.play().catch((e) => console.warn('[weeek-ext] sound playback failed:', e));
  } catch (e) {
    console.warn('[weeek-ext] sound setup failed:', e);
  }
  return undefined;
});
