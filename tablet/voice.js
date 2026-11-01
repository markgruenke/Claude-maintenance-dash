/* Speech-to-text using the browser's built-in recognition (Web Speech API).
 *
 * Only works on a secure page (https://, or http://localhost on the PC
 * itself): browsers block microphone access on plain http:// addresses like
 * http://192.168.1.50:3000. When it isn't available, the Today screen falls
 * back to the tablet keyboard's own microphone key, which works anywhere.
 *
 * Note: Chrome sends the audio to Google's servers to transcribe it, so it
 * needs an internet connection.
 */

const SR = window.SpeechRecognition || window.webkitSpeechRecognition;

export function voiceSupport() {
  if (!SR) return { ok: false, reason: 'browser' };
  if (!window.isSecureContext) return { ok: false, reason: 'insecure' };
  return { ok: true };
}

const ERRORS = {
  'not-allowed': 'Microphone permission was blocked. Allow the microphone for this site in the browser settings.',
  'service-not-allowed': 'Speech recognition is turned off in this browser.',
  'audio-capture': 'No microphone found.',
  network: 'Speech recognition needs an internet connection.',
};

/**
 * Start listening. Keeps going through pauses until stop() is called, or
 * until it has heard nothing for `silenceMs` after you stop talking.
 *
 * @param {object} cb
 * @param {(text: string) => void} cb.onText   running transcript (final + in-progress words)
 * @param {(text: string) => void} cb.onDone   called once with the final transcript ('' if nothing heard)
 * @param {(msg: string) => void}  cb.onError
 * @returns {{ stop: () => void, cancel: () => void }}
 */
export function listen({ onText, onDone, onError, silenceMs = 15000, maxMs = 5 * 60000 }) {
  // Android Chrome repeats earlier words when continuous mode is on, so
  // there we take one phrase at a time and restart between phrases.
  const android = /Android/i.test(navigator.userAgent);
  let committed = '';       // finished phrases from earlier sessions
  let sessionFinal = '';    // finished phrases in the current session
  let interim = '';
  let active = true;
  let finished = false;
  let rec = null;
  let silenceTimer = null;
  const started = Date.now();

  const full = () => [committed, sessionFinal, interim].map((s) => s.trim()).filter(Boolean).join(' ');

  const finish = () => {
    if (finished) return;
    finished = true;
    active = false;
    clearTimeout(silenceTimer);
    try { rec && rec.stop(); } catch { /* already stopped */ }
    interim = '';
    onDone(full());
  };

  const armSilence = () => {
    clearTimeout(silenceTimer);
    silenceTimer = setTimeout(() => { if (full()) finish(); }, silenceMs);
  };

  const startSession = () => {
    rec = new SR();
    rec.lang = navigator.language || 'en-US';
    rec.continuous = !android;
    rec.interimResults = true;
    rec.maxAlternatives = 1;
    sessionFinal = '';
    rec.onresult = (e) => {
      // Rebuild this session's text from the full results list each time
      // (robust against browsers that resend earlier results).
      let fin = '';
      let mid = '';
      for (let i = 0; i < e.results.length; i++) {
        const t = e.results[i][0].transcript;
        if (e.results[i].isFinal) fin += ' ' + t; else mid += ' ' + t;
      }
      sessionFinal = fin.trim();
      interim = mid.trim();
      onText(full());
      armSilence();
    };
    rec.onerror = (e) => {
      if (e.error === 'no-speech' || e.error === 'aborted') return; // restart handles it
      active = false;
      onError(ERRORS[e.error] || 'Speech recognition error: ' + e.error);
    };
    rec.onend = () => {
      committed = [committed, sessionFinal].filter(Boolean).join(' ');
      sessionFinal = '';
      interim = '';
      if (active && !finished && Date.now() - started < maxMs) {
        try { startSession(); return; } catch { /* fall through to finish */ }
      }
      finish();
    };
    rec.start();
  };

  // Nothing heard at all in 20 seconds: give up quietly.
  setTimeout(() => { if (!finished && !full()) finish(); }, 20000);

  try {
    startSession();
  } catch (err) {
    onError('Could not start the microphone: ' + err.message);
    finished = true;
  }

  return {
    stop: () => { active = false; try { rec && rec.stop(); } catch { finish(); } },
    cancel: () => { finished = true; active = false; clearTimeout(silenceTimer); try { rec && rec.abort(); } catch { /* */ } },
  };
}
