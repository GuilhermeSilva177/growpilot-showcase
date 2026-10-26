// Detecta equipamento "ligado sem efeito": o umidificador/desumidificador esta
// ligado ha bastante tempo, a umidade continua fora da faixa e nao esta indo na
// direcao certa. Costuma ser reservatorio cheio/vazio, filtro entupido, tomada
// sem energia ou aparelho com defeito. (O AC ja tem o proprio vigia no
// controlLoop: climateStallMinutes.)
const MIN_MINUTES = Number(process.env.EFFECT_CHECK_MINUTES) || 45;
const MIN_PROGRESS_PCT = Number(process.env.EFFECT_CHECK_MIN_PROGRESS_PCT) || 1.0; // pontos de UR

function avg(list, pick) {
  const v = list.map(pick).filter((x) => typeof x === 'number' && !isNaN(x));
  return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
}

// Ha quantos minutos o equipamento esta ligado SEM parar (contando do fim).
function continuousOnPoints(points, isOn) {
  const out = [];
  for (let i = points.length - 1; i >= 0; i--) {
    if (!isOn(points[i])) break;
    out.unshift(points[i]);
  }
  return out;
}

function minutesSpan(pts) {
  if (pts.length < 2) return 0;
  return (new Date(pts[pts.length - 1].t) - new Date(pts[0].t)) / 60000;
}

function check(points, targets, alerts) {
  if (!Array.isArray(points) || points.length < 10 || !targets || !targets.rh) return;
  const [rhMin, rhMax] = targets.rh;
  const rules = [
    {
      key: 'dehumidifier', name: 'Desumidificador', isOn: (p) => p.equip && p.equip.dehumidifier,
      bad: (end, delta) => end > rhMax && delta > -MIN_PROGRESS_PCT,
      hint: 'confira se o reservatório está cheio, o filtro limpo e se a tomada está com energia.'
    },
    {
      key: 'humidifier', name: 'Umidificador', isOn: (p) => p.equip && p.equip.humidifier,
      bad: (end, delta) => end < rhMin && delta < MIN_PROGRESS_PCT,
      hint: 'confira se há água no reservatório, se o bico não está entupido e se a tomada está com energia.'
    }
  ];
  rules.forEach((r) => {
    const run = continuousOnPoints(points, r.isOn);
    if (minutesSpan(run) < MIN_MINUTES || run.length < 8) return;
    const head = run.slice(0, 3), tail = run.slice(-3);
    const rhStart = avg(head, (p) => p.rhPct), rhEnd = avg(tail, (p) => p.rhPct);
    if (rhStart == null || rhEnd == null) return;
    const delta = rhEnd - rhStart;
    if (r.bad(rhEnd, delta)) {
      alerts.sendAlertAsync(
        'ineffective_' + r.key,
        `⚠️ *${r.name}* está ligado há ${Math.round(minutesSpan(run))} min e a umidade não está respondendo (UR ${rhStart.toFixed(1)}% → ${rhEnd.toFixed(1)}%, faixa ${rhMin}–${rhMax}%).\n\nO comando foi enviado, mas o efeito não apareceu — ${r.hint}`
      );
    }
  });
}

module.exports = { check };
