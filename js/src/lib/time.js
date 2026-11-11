/**
 * Dates, formats et fenetre affichee — **fonctions pures**, sans React ni DOM
 * (`js/test/time.test.mjs`).
 *
 * Tout est en **millisecondes epoch** et en heure **locale** : le Gantt dessine d'apres
 * `start_date` telle que l'UI Airflow l'affiche, et une « journee » est locale (le serveur
 * renvoie deja des dates naive locales).
 */

export const DAY_MS = 24 * 3600 * 1000;
export const MIN_SPAN_MS = 3 * 3600 * 1000; // largeur mini de la fenetre en zoom auto : 3 h
export const MARGIN_RATIO = 0.05; // ~5 % d'air de chaque cote
export const TICK_STEPS_MIN = [5, 10, 15, 30, 60, 120, 240]; // paliers de graduation
export const MAX_TICKS = 12;

export const todayLocal = () => {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};

// Decale une date locale 'YYYY-MM-DD' de `days` jours (minuit local : pas de decalage UTC).
export const shiftDate = (iso, days) => {
  const [y, m, d] = (iso || todayLocal()).split('-').map(Number);
  if (!y || !m || !d) return todayLocal();
  const dt = new Date(y, m - 1, d + days);
  const pad = (n) => String(n).padStart(2, '0');
  return `${dt.getFullYear()}-${pad(dt.getMonth() + 1)}-${pad(dt.getDate())}`;
};

export const fmtTimeMs = (ms) =>
  Number.isFinite(ms)
    ? new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
    : '—';

export const fmtTime = (iso) => fmtTimeMs(Date.parse(iso));

export const fmtDuration = (ms) => {
  if (!Number.isFinite(ms) || ms < 0) return '—';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`;
};

export const fmtClock = (ms) => new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

// Étendue de la fenêtre en deux caractères pour la puce : « 9 h », « 45 min », « 24 h ».
export const fmtSpanShort = (ms) => {
  const h = Math.round(ms / 3600000);
  if (h >= 1) return `${h} h`;
  return `${Math.max(1, Math.round(ms / 60000))} min`;
};

// Plus petit palier tel qu'on garde <= MAX_TICKS graduations sur le span donne.
export const pickStepMs = (spanMs) => {
  const step = TICK_STEPS_MIN.find((m) => spanMs / (m * 60000) <= MAX_TICKS);
  return (step || TICK_STEPS_MIN[TICK_STEPS_MIN.length - 1]) * 60000;
};

/* Fenetre affichee : journee complete [00:00, 24:00), ou zoom sur les runs filtres
   (1er start -> derniere fin, MIN_SPAN_MS minimum, bornes arrondies sur le palier
   de graduation et clampées dans la journee). */
export const computeWindow = (runs, dayStart, zoom, nowMs) => {
  const dayEnd = dayStart + DAY_MS;
  const full = { windowStart: dayStart, windowSpan: DAY_MS, zoomed: false };
  if (!zoom || runs.length === 0) return full;

  let t0 = Infinity;
  let t1 = -Infinity;
  runs.forEach((r) => {
    const s = Date.parse(r.start);
    if (Number.isNaN(s)) return; // run sans start exploitable : ignore
    const e = r.end ? Date.parse(r.end) : nowMs; // running / queued -> etire jusqu'a maintenant
    t0 = Math.min(t0, s);
    t1 = Math.max(t1, Number.isNaN(e) ? s : e);
  });
  if (!Number.isFinite(t0)) return full; // aucun run avec un start valide

  const margin = Math.max((t1 - t0) * MARGIN_RATIO, 60000); // au moins 1 min d'air
  t0 -= margin;
  t1 += margin;
  if (t1 - t0 < MIN_SPAN_MS) {
    const mid = (t0 + t1) / 2; // run isolé / journee tres chargee -> 3 h centrees
    t0 = mid - MIN_SPAN_MS / 2;
    t1 = mid + MIN_SPAN_MS / 2;
  }
  if (t1 - t0 >= DAY_MS) return full;

  // Arrondi sur le palier de graduation, aligne sur minuit local (pas sur l'epoch :
  // les decalages de fuseau ne sont pas tous ronds).
  const stepMs = pickStepMs(t1 - t0);
  const align = (t, dir) => dayStart + dir((t - dayStart) / stepMs) * stepMs;
  t0 = align(t0, Math.floor);
  t1 = align(t1, Math.ceil);
  // Clamp dans la journee : si un bord depasse, on glisse la fenetre de l'autre cote.
  const span = Math.min(t1 - t0, DAY_MS);
  t0 = Math.min(Math.max(t0, dayStart), dayEnd - span);
  t1 = t0 + span;
  return { windowStart: t0, windowSpan: t1 - t0, zoomed: true };
};

/**
 * Graduations adaptees a la fenetre : palier choisi pour rester <= MAX_TICKS traits,
 * aligne sur minuit local (`dayStart`) — sinon les traits glisseraient selon la fenetre.
 * En dessous de l'heure, `HH:MM`, au-dela `HHh`.
 */
/**
 * Graduations adaptees a la fenetre : palier choisi pour rester <= MAX_TICKS traits, aligne
 * sur minuit local (`dayStart`) — sinon les traits glisseraient selon la fenetre.
 * Recopié tel quel du `useMemo` du composant.
 */
export const buildTicks = ({ windowStart, windowSpan, dayStart }) => {
    const stepMs = pickStepMs(windowSpan);
    const out = [];
    const first = dayStart + Math.ceil((windowStart - dayStart) / stepMs) * stepMs;
    const end = windowStart + windowSpan;
    for (let t = first; t <= end + 1; t += stepMs) {
      const d = new Date(t);
      const label =
        stepMs < 3600000
          ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
          : `${String(d.getHours()).padStart(2, '0')}h`;
      out.push({ t, pct: ((t - windowStart) / windowSpan) * 100, label });
    }
    return out;
  
};
