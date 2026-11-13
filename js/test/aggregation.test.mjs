/**
 * Tests du module d'agrégation — zéro dépendance (jest n'est pas installé) :
 *
 *   node js/test/aggregation.test.mjs
 *
 * Le module source est en ESM sans `package.json#type` : Node >= 23 détecte la
 * syntaxe et le charge comme module (vérifié en Node 26).
 */
import assert from 'node:assert/strict';
import { BAR_HEIGHT, ROW_HEIGHT } from '../src/lib/constants.js';
import {
  barGeometry,
  barHref,
  barLabel,
  barStyle,
  barVisualProps,
  BIN_OPTIONS,
  bucketize,
  isLinkable,
  autoBinMs,
  binLabel,
  packLanes,
  parseBin,
  worstState,
} from '../src/lib/aggregation.js';

const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const DAY_START = Date.parse('2026-11-10T00:00:00');
const NOW = Date.parse('2026-11-10T18:00:00');
const at = (hm, s = 0) => {
  const [h, m] = hm.split(':').map(Number);
  return DAY_START + ((h * 60 + m) * 60 + s) * 1000;
};
const iso = (ms) => new Date(ms).toISOString();
const run = (i, startMs, endMs, state = 'success', dagId = 'ALIVE') => ({
  dag_id: dagId,
  run_id: `run_${i}`,
  state,
  start: iso(startMs),
  end: endMs == null ? null : iso(endMs),
  tags: ['spark'],
});

let checks = 0;
const it = (name, fn) => {
  fn();
  checks += 1;
  console.log(`  ok  ${name}`);
};

// ---------- parseBin / binLabel / BIN_OPTIONS ----------
it('parseBin : minutes, off et auto', () => {
  assert.equal(parseBin('5m'), 5 * MIN);
  assert.equal(parseBin('60m'), 60 * MIN);
  assert.equal(parseBin('off'), null);
  assert.equal(parseBin('auto'), undefined);
  assert.equal(parseBin('n importe quoi'), undefined);
  assert.equal(parseBin(undefined), undefined);
});

it('BIN_OPTIONS : auto et off en tete, valeurs parsables', () => {
  assert.equal(BIN_OPTIONS[0].value, 'auto');
  assert.equal(BIN_OPTIONS[1].value, 'off');
  assert.deepEqual(
    BIN_OPTIONS.map((o) => o.value),
    ['auto', 'off', '1m', '5m', '15m', '30m', '60m']
  );
  BIN_OPTIONS.forEach((o) => assert.notEqual(parseBin(o.value), 'n importe quoi'));
});

it('binLabel : libellés lisibles', () => {
  assert.equal(binLabel(null), 'off');
  assert.equal(binLabel(5 * MIN), '5 min');
  assert.equal(binLabel(60 * MIN), '1 h');
});

// ---------- autoBinMs ----------
it('autoBinMs : paliers 3 h / 6 h / 12 h', () => {
  assert.equal(autoBinMs(1 * 3600_000), MIN);
  assert.equal(autoBinMs(3 * 3600_000), MIN);
  assert.equal(autoBinMs(3 * 3600_000 + 1), 5 * MIN);
  assert.equal(autoBinMs(6 * 3600_000), 5 * MIN);
  assert.equal(autoBinMs(9 * 3600_000), 15 * MIN);
  assert.equal(autoBinMs(12 * 3600_000), 15 * MIN);
});

it('autoBinMs : plafonné à 30 min, même sur 24 h', () => {
  assert.equal(autoBinMs(13 * 3600_000), 30 * MIN);
  assert.equal(autoBinMs(24 * 3600_000), 30 * MIN);
  assert.equal(autoBinMs(undefined), MIN); // fenêtre inconnue -> le plus fin
});

// ---------- worstState ----------
it('worstState : failed prime sur tout', () => {
  assert.equal(worstState(['success', 'success', 'failed']), 'failed');
  assert.equal(worstState({ success: 10, failed: 2 }), 'failed');
  assert.equal(worstState({ success: 10, running: 1 }), 'running');
  assert.equal(worstState({ success: 3, queued: 1 }), 'queued');
  assert.equal(worstState({ success: 3, planned: 1 }), 'planned');
  assert.equal(worstState({ success: 2 }), 'success');
  assert.equal(worstState([]), null);
});

it('worstState : etat inconnu (none) jamais prioritaire', () => {
  assert.equal(worstState({ none: 4, success: 1 }), 'success');
  assert.equal(worstState({ none: 4 }), 'none');
});

// ---------- bucketize : off ----------
it('bucketize off : un item par run, aucun changement', () => {
  const runs = [run(1, at('14:05'), at('14:06')), run(2, at('14:05', 30), at('14:07'))];
  const items = bucketize(runs, DAY_START, null, NOW);
  assert.equal(items.length, 2);
  items.forEach((item) => assert.equal(item.kind, 'run'));
  assert.equal(items[0].key, 'r:ALIVE:run_1');
  assert.equal(items[0].count, 1);
  assert.equal(items[0].run, runs[0]); // référence au run de l'API
});

// ---------- bucketize : fusion ----------
it('bucketize : fusionne par tranche de 5 min, isole le run de la tranche suivante', () => {
  const runs = [
    run(1, at('14:01'), at('14:03')),
    run(2, at('14:02'), at('14:04')),
    run(3, at('14:04', 30), at('14:09')),
    run(4, at('14:07'), at('14:08')), // tranche 14:05-14:10 -> seul
  ];
  const items = bucketize(runs, DAY_START, 5 * MIN, NOW);
  assert.equal(items.length, 2);
  const [bucket, alone] = items;
  assert.equal(bucket.kind, 'bucket');
  assert.equal(bucket.count, 3);
  assert.equal(alone.kind, 'run');
  assert.equal(alone.key, 'r:ALIVE:run_4');
});

it('bucketize : bornes = vraies dates des runs, pas les bords de la tranche', () => {
  const runs = [
    run(1, at('14:01', 10), at('14:03')),
    run(2, at('14:02'), at('14:09', 30)),
  ];
  const [item] = bucketize(runs, DAY_START, 5 * MIN, NOW);
  assert.equal(item.startMs, at('14:01', 10));
  assert.equal(item.endMs, at('14:09', 30));
  assert.equal(item.open, false);
});

it('bucketize : rouge des qu un run a echoue, etats comptes', () => {
  const runs = [
    run(1, at('14:01'), at('14:02'), 'success'),
    run(2, at('14:02'), at('14:03'), 'failed'),
    run(3, at('14:03'), at('14:04'), 'success'),
  ];
  const [item] = bucketize(runs, DAY_START, 5 * MIN, NOW);
  assert.deepEqual(item.states, { success: 2, failed: 1 });
  assert.equal(item.state, 'failed');
  assert.equal(item.running, false);
});

it('bucketize : un bucket avec un run en cours etire la barre a maintenant', () => {
  const runs = [
    run(1, at('14:01'), at('14:02'), 'success'),
    run(2, at('14:03'), null, 'running'),
  ];
  const [item] = bucketize(runs, DAY_START, 5 * MIN, NOW);
  assert.equal(item.open, true);
  assert.equal(item.running, true);
  assert.equal(item.state, 'running'); // pas d echec -> etat « en cours »
  assert.equal(item.endMs, NOW);
});

it('bucketize : un run en cours seul est aussi etire a maintenant', () => {
  const [item] = bucketize([run(1, at('14:01'), null, 'running')], DAY_START, 5 * MIN, NOW);
  assert.equal(item.kind, 'run');
  assert.equal(item.endMs, NOW);
  assert.equal(item.open, true);
});

it('bucketize : un run sans start parsable n est jamais fusionne', () => {
  const broken = { ...run(99, at('14:02'), at('14:03')), start: 'pas une date' };
  const runs = [run(1, at('14:01'), at('14:02')), broken, run(3, at('14:02', 30), at('14:04'))];
  const items = bucketize(runs, DAY_START, 5 * MIN, NOW);
  // Le run cabosse sort seul (item `run`, startMs null) ; les deux autres
  // restent fusionnes : il ne casse pas le groupe.
  assert.equal(items.length, 2);
  assert.deepEqual(items.map((i) => i.kind), ['run', 'bucket']);
  assert.equal(items[0].run, broken);
  assert.equal(items[0].startMs, null);
  assert.equal(items[1].count, 2);
});

it('bucketize : ne fusionne pas deux DAGs dans la meme tranche', () => {
  const runs = [run(1, at('14:01'), at('14:02'), 'success', 'A'), run(2, at('14:02'), at('14:03'), 'success', 'B')];
  const items = bucketize(runs, DAY_START, 5 * MIN, NOW);
  assert.equal(items.length, 2);
  items.forEach((i) => assert.equal(i.kind, 'run'));
});

it('bucketize : tranche alignee sur le debut de journee locale', () => {
  // 09:59:30 et 10:00:10 sont dans des tranches differentes (bornes sur 5 min rondes)
  const runs = [run(1, at('09:59', 30), at('10:00')), run(2, at('10:00', 10), at('10:02'))];
  const items = bucketize(runs, DAY_START, 5 * MIN, NOW);
  assert.equal(items.length, 2);
  // memes tranches : 09:55 -> 10:00
  const same = [run(1, at('09:56'), at('10:00')), run(2, at('09:58'), at('10:02'))];
  assert.equal(bucketize(same, DAY_START, 5 * MIN, NOW).length, 1);
});

it('bucketize : 1126 runs reguliers -> 1 barre par tranche de 5 min', () => {
  const runs = [];
  for (let i = 0; i < 1126; i += 1) {
    const start = at('00:00') + i * 45 * 1000; // un run toutes les 45 s
    runs.push(run(i + 1, start, start + 30 * 1000, i % 4 === 0 ? 'failed' : 'success'));
  }
  const items = bucketize(runs, DAY_START, 5 * MIN, NOW);
  assert.equal(items.length, 169); // 1126 runs * 45 s = 14 h -> 169 tranches de 5 min
  assert.ok(items.every((i) => i.kind === 'bucket'));
  assert.equal(items.reduce((n, i) => n + i.count, 0), 1126);
  assert.equal(items[0].state, 'failed'); // un echec sur 4 des le premier bucket
});

it('bucketize : vide et dayStart invalide ne cassent rien', () => {
  assert.deepEqual(bucketize([], DAY_START, 5 * MIN, NOW), []);
  assert.deepEqual(bucketize(undefined, DAY_START, 5 * MIN, NOW), []);
  const items = bucketize([run(1, at('14:01'), at('14:02')), run(2, at('14:02'), at('14:03'))], NaN, 5 * MIN, NOW);
  assert.equal(items.length, 1); // ref sur l'epoch : toujours une tranche commune
});

it('bucketize : les buckets portent une cle unique et stable', () => {
  const runs = [run(1, at('14:01'), at('14:02')), run(2, at('14:02'), at('14:03'))];
  const a = bucketize(runs, DAY_START, 5 * MIN, NOW);
  const b = bucketize(runs, DAY_START, 5 * MIN, NOW + 60_000);
  assert.equal(a[0].key, b[0].key);
  assert.notEqual(a[0].key, 'r:ALIVE:run_1');
});

// ---------- packLanes ----------
it('packLanes : pas de chevauchement, lanes reels, identite conservee', () => {
  const runs = [
    run(1, at('14:00'), at('14:10')),
    run(2, at('14:05'), at('14:15')), // chevauche run_1 -> lane 1
    run(3, at('14:20'), at('14:25')), // libre -> lane 0
  ];
  const items = bucketize(runs, DAY_START, null, NOW);
  const { packed, lanes } = packLanes(items, 6);
  assert.deepEqual(packed.map((i) => i.lane), [0, 1, 0]);
  assert.equal(lanes, 2);
  // Un lane inchangé ne recrée pas l'objet (React.memo sur la barre reste efficace)
  const again = packLanes(packed, 6);
  assert.equal(again.packed[0], packed[0]);
});

it('packLanes : surcharge plafonnee a maxLanes', () => {
  const start = at('14:00');
  const runs = Array.from({ length: 12 }, (_, i) => run(i + 1, start, start + 60 * MIN));
  const items = bucketize(runs, DAY_START, null, NOW); // off : 12 items qui se chevauchent
  const { packed, lanes } = packLanes(items, 6);
  assert.equal(lanes, 6);
  assert.ok(packed.every((i) => i.lane >= 0 && i.lane < 6));
  assert.equal(packed.filter((i) => i.lane === 5).length, 7); // lanes 0..4 pleins + tout le reste
});

it('packLanes : un bucket monopolise sa tranche horaire', () => {
  const runs = [];
  for (let i = 0; i < 40; i += 1) {
    const start = at('14:00') + i * 45 * 1000;
    runs.push(run(i + 1, start, start + 30 * 1000));
  }
  const { packed, lanes } = packLanes(bucketize(runs, DAY_START, 5 * MIN, NOW), 6);
  assert.equal(lanes, 1); // buckets sequentiellement non chevauchants
  assert.equal(packed.length, 6); // 40 runs * 45 s = 29 min -> 6 tranches de 5 min
});

it('packLanes : items vides ou sans start ne cassent rien', () => {
  assert.deepEqual(packLanes([], 6), { packed: [], lanes: 1 });
  const broken = bucketize([{ ...run(1, at('14:00'), at('14:01')), start: 'nope' }], DAY_START, 5 * MIN, NOW);
  const { lanes } = packLanes(broken, 6);
  assert.equal(lanes, 1);
});

// ---------- barHref ----------
it('barHref : un run isolé pointe sur sa grille', () => {
  const [item] = bucketize([run(7, at('14:01'), at('14:02'), 'failed')], DAY_START, 5 * MIN, NOW);
  assert.equal(barHref(item), '/dags/ALIVE/runs/run_7');
});

it('barHref : un bucket pointe sur les runs du DAG **de la journee**, sans etat', () => {
  const runs = [
    run(1, at('14:01'), at('14:02'), 'success'),
    run(2, at('14:02'), at('14:09'), 'failed'),
  ];
  const [item] = bucketize(runs, DAY_START, 5 * MIN, NOW);
  const url = new URL(`http://h${barHref(item, DAY_START)}`);
  assert.equal(url.pathname, '/dags/ALIVE/runs');
  // Journee complete : minuit local -> minuit local du lendemain (marge UTC comprise).
  assert.equal(url.searchParams.get('run_after_gte'), iso(DAY_START - HOUR));
  assert.equal(url.searchParams.get('run_after_lte'), iso(DAY_START + DAY + HOUR));
  assert.equal(url.searchParams.get('state'), null); // plus aucun filtre d'etat
});

it('barHref : le filtre ne depend plus de la tranche ni des etats', () => {
  const mk = (hm, state) => barHref(bucketize([run(1, at(hm), at(hm) + MIN, state)], DAY_START, 5 * MIN, NOW)[0], DAY_START);
  const bucket = (hm) => barHref(bucketize([run(1, at(hm), at(hm) + MIN, 'success'), run(2, at(hm), at(hm) + 2 * MIN, 'success')], DAY_START, 5 * MIN, NOW)[0], DAY_START);
  assert.equal(bucket('00:01'), bucket('23:00')); // une seule journee -> une seule URL
  assert.match(mk('14:00'), /\/dags\/ALIVE\/runs\/run_1$/); // run unique : grille du run
});

it('barHref : sans dayStart, repli sur les bornes de la barre', () => {
  const [item] = bucketize([run(1, at('14:01'), at('14:05'), 'success'), run(2, at('14:02'), at('14:06'), 'success')], DAY_START, 5 * MIN, NOW);
  const url = new URL(`http://h${barHref(item)}`);
  assert.equal(url.searchParams.get('run_after_gte'), iso(at('14:01')));
  assert.equal(url.searchParams.get('run_after_lte'), iso(at('14:06')));
});

it('barHref : bucket sans run_id connu = liste bombee, pas un lien casse', () => {
  const runs = [run(1, at('14:01'), at('14:02')), run(2, at('14:02'), at('14:03'))];
  const [item] = bucketize(runs, DAY_START, 5 * MIN, NOW);
  const broken = { ...item, kind: 'run', run: { dag_id: item.dagId } }; // run sans run_id
  assert.match(barHref(broken, DAY_START), /^\/dags\/ALIVE\/runs\?run_after_gte=/);
});

it('barHref : bucket monotone = meme URL qu\'un bucket mixte', () => {
  const runs = [run(1, at('14:01'), at('14:02'), 'success'), run(2, at('14:02'), at('14:03'), 'success')];
  const [item] = bucketize(runs, DAY_START, 5 * MIN, NOW);
  const want = new URL(`http://h/dags/ALIVE/runs?run_after_gte=${iso(DAY_START - HOUR)}&run_after_lte=${iso(DAY_START + DAY + HOUR)}`);
  const got = new URL(`http://h${barHref(item, DAY_START)}`);
  assert.equal(got.pathname, want.pathname);
  assert.deepEqual([...got.searchParams.entries()], [...want.searchParams.entries()]);
});

it('barHref : dag_id et run_id echappes', () => {
  const odd = { ...run(1, at('14:01'), at('14:02'), 'failed'), dag_id: 'a b/c', run_id: 'manual__+1' };
  const [item] = bucketize([odd], DAY_START, 5 * MIN, NOW);
  assert.equal(barHref(item), '/dags/a%20b%2Fc/runs/manual__%2B1');
});

// ---------- logique de la barre (extraite de `Bar.jsx`, donc testable ici) ----------

const DAY_WINDOW = { windowStart: DAY_START, windowSpan: DAY, chartWidth: 1000 };
const bucketAt = (from, to, state = 'success') =>
  bucketize([run(1, at(from), at(to), state), run(2, at(from) + MIN, at(to) + MIN, state)], DAY_START, 60 * MIN, NOW)[0];

it('barGeometry : position et largeur en % de la journee', () => {
  const geo = barGeometry({ startMs: at('12:00'), endMs: at('18:00') }, DAY_WINDOW);
  assert.equal(geo.left, 50, '12 h sur 24 h = la moitie');
  assert.equal(geo.width, 25, '6 h sur 24 h = un quart');
  assert.equal(geo.widthPx, 250, 'et 250 px sur une zone de 1000 px');
});

it('barGeometry : plancher a 0,35 % pour rester survolable', () => {
  const geo = barGeometry({ startMs: at('06:00'), endMs: at('06:01') }, DAY_WINDOW);
  assert.equal(geo.width, 0.35, 'une minute sur 24 h ne se voit pas : on la rend visible');
  assert.ok(geo.widthPx > 3, 'et assez large pour une souris');
});

it('barGeometry : ramene dans la zone, jamais avant', () => {
  const before = barGeometry({ startMs: at('01:00'), endMs: at('02:00') }, { ...DAY_WINDOW, windowStart: at('01:30') });
  assert.equal(before.left, 0, 'une barre commence jamais avant la zone');
  assert.ok(before.width > 0 && before.width < 100, 'et garde une largeur positive');
  const after = barGeometry({ startMs: at('01:00'), endMs: at('05:00') }, { ...DAY_WINDOW, windowSpan: 3 * HOUR });
  assert.equal(after.left + after.width, 100, 'elle ne deborde pas non plus : le bord droit est borne');
});

it('barGeometry : run sans date ou mal ne = un point, pas un calcul negatif', () => {
  const blind = barGeometry({}, DAY_WINDOW);
  assert.equal(blind.startMs, DAY_WINDOW.windowStart, 'un item sans start se cale sur la fenetre');
  assert.equal(blind.endMs, blind.startMs, 'et sans end, il ne s\'etire pas');
  const reversed = barGeometry({ startMs: at('10:00'), endMs: at('09:00') }, DAY_WINDOW);
  assert.equal(reversed.endMs, reversed.startMs, 'une fin avant le debut est ramenee au debut');
});

it('barGeometry : largeur inconnue = widthPx a null (seuil en %)', () => {
  const geo = barGeometry({ startMs: at('12:00'), endMs: at('18:00') }, { windowStart: DAY_START, windowSpan: DAY, chartWidth: 0 });
  assert.equal(geo.widthPx, null, 'pas encore mesure (useChartWidth) : on ne devine pas les px');
});

it('barLabel : le compte et la duree seulement si ca rentre', () => {
  const item = bucketAt('12:00', '14:00'); // bucket 12:00 -> 14:01, 2 runs
  assert.equal(item.count, 2, 'les deux runs sont bien fusionnes');
  assert.equal(barLabel({ ...item, running: false }, barGeometry(item, DAY_WINDOW)), '2× · 2h 01m', 'large : le compte et la duree');
  assert.equal(barLabel({ ...item, running: false }, barGeometry(item, { ...DAY_WINDOW, chartWidth: 600 })), '2×', 'etroit : le compte reste, la duree disparait');
  assert.equal(barLabel({ ...item, running: false }, barGeometry(item, { ...DAY_WINDOW, chartWidth: 200 })), '', 'trop etroit : rien d\'imposable, on ne troncature pas');
});

it('barLabel : un run en cours marque ▶, meme dans une barre etroite', () => {
  const short = { key: 'k', dagId: 'ALIVE', kind: 'bucket', state: 'running', count: 3, running: true, startMs: at('14:00'), endMs: at('14:04') };
  assert.equal(barLabel(short, barGeometry(short, DAY_WINDOW)), '▶', '4 minutes = pas de place pour « 3× »');
  const wide = barGeometry(short, { ...DAY_WINDOW, chartWidth: 60_000 });
  assert.equal(barLabel(short, wide), '▶ 3× · 4m 0s', 'assez large : le ▶ est suivi d\'une espace');
  assert.equal(barLabel({ ...short, running: false }, wide), '3× · 4m 0s', 'sans run en cours, pas d\'espace fantome');
});

it('barVisualProps : couleur de l\'etat, opacite, bordure du run en cours', () => {
  const failed = barVisualProps({ state: 'failed' });
  assert.equal(failed.bg, 'failed.solid', 'couleur = token du thème de l\'hote, jamais un hex');
  assert.equal(failed.opacity, 1);
  assert.equal(barVisualProps({ state: 'success' }).opacity, 0.9, 'une barre de succes se fond un peu');
  assert.equal(barVisualProps({ state: null }).bg, 'gray.solid', 'etat inconnu = gris');
  assert.equal(barVisualProps({ state: 'success', running: true }).border, '1px solid', 'un bucket contenant un run en cours se bordure');
  assert.equal(barVisualProps({ state: 'success' }).border, 'none');
});

it('isLinkable : seule une barre utile en clic devient un lien', () => {
  assert.equal(isLinkable({ state: 'success', count: 1 }), true, 'run unique = sa grille');
  assert.equal(isLinkable({ state: 'failed', count: 9 }), true, 'echec, meme en bucket = les logs');
  assert.equal(isLinkable({ state: 'success', count: 9 }), false, 'bucket reussi = muet (le tooltip suffit)');
  assert.equal(isLinkable({ state: 'running', count: 9 }), false, 'bucket en cours non plus : pas de fausse affordance');
});

it('barStyle : lane = pas vertical, et display block pour un <a>', () => {
  const item = { lane: 2, startMs: at('12:00'), endMs: at('13:00') };
  const style = barStyle(item, barGeometry(item, DAY_WINDOW));
  assert.equal(style.top, `${2 * ROW_HEIGHT}px`, 'la lane 2 est deux pas plus bas');
  assert.equal(style.height, `${BAR_HEIGHT}px`, 'une barre fait toujours BAR_HEIGHT');
  assert.equal(style.display, 'block', '<a> est inline : sans bloc, les % ne suivent pas');
  assert.equal(barStyle({ ...item, lane: undefined }, barGeometry(item, DAY_WINDOW)).top, '0px', 'sans lane assignee, premiere lane');
});

console.log(`\naggregation.test.mjs : ${checks} tests passés`);