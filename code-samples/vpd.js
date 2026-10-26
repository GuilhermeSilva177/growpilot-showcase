// Pressao de saturacao de vapor (formula de Tetens), em kPa
function svp(tempC) {
  return 0.6108 * Math.exp((17.27 * tempC) / (tempC + 237.3));
}

// VPD do ar: diferenca entre a pressao de saturacao no ar e a pressao real de vapor
function airVPD(tempC, rhPct) {
  const s = svp(tempC);
  return s - s * (rhPct / 100);
}

// VPD "de folha": usa a pressao de saturacao na temperatura da FOLHA (geralmente
// um pouco diferente do ar por causa da transpiracao/radiacao das luzes), mas a
// umidade relativa medida no ar -- e a metrica mais relevante para crop steering.
function leafVPD(airTempC, rhPct, leafOffsetC) {
  const leafTempC = airTempC + leafOffsetC;
  const sLeaf = svp(leafTempC);
  const sAir = svp(airTempC);
  const avp = sAir * (rhPct / 100); // pressao real de vapor no ar
  return sLeaf - avp;
}

// Inverso da funcao acima: dado a temperatura do ar e um VPD-alvo (de folha),
// calcula qual UMIDADE relativa do ar produz esse VPD. E o que permite o modo
// "temperatura prioritaria": voce fixa a faixa de temperatura, o sistema calcula
// a faixa de umidade necessaria a cada leitura para manter o VPD ideal.
function rhForTargetVPD(airTempC, targetVpdKpa, leafOffsetC) {
  const leafTempC = airTempC + leafOffsetC;
  const sLeaf = svp(leafTempC);
  const sAir = svp(airTempC);
  const rh = (100 * (sLeaf - targetVpdKpa)) / sAir;
  return Math.max(0, Math.min(100, rh));
}

// Diagnostica O QUE esta empurrando o VPD para fora da faixa ideal: temperatura,
// umidade, os dois, ou uma combinacao que isoladamente parece ok mas junta nao fecha.
function diagnoseVPD({ tempC, rhPct, leafOffsetC, targets }) {
  const [tempMin, tempMax] = targets.tempC;
  const [rhMin, rhMax] = targets.rh;
  const [vpdMin, vpdMax] = targets.vpd;

  const actualVpd = leafVPD(tempC, rhPct, leafOffsetC);

  if (actualVpd >= vpdMin && actualVpd <= vpdMax) {
    return { status: 'ideal', cause: null, message: 'VPD dentro da faixa ideal.', actualVpd };
  }

  const direction = actualVpd > vpdMax ? 'alto' : 'baixo';
  const tempMid = (tempMin + tempMax) / 2;
  const rhMid = (rhMin + rhMax) / 2;

  const vpdIfTempIdeal = leafVPD(tempMid, rhPct, leafOffsetC);
  const vpdIfRhIdeal = leafVPD(tempC, rhMid, leafOffsetC);
  const tempContribution = Math.abs(actualVpd - vpdIfTempIdeal);
  const rhContribution = Math.abs(actualVpd - vpdIfRhIdeal);

  const tempOut = tempC < tempMin || tempC > tempMax;
  const rhOut = rhPct < rhMin || rhPct > rhMax;
  const tempDeviation = tempC > tempMax ? tempC - tempMax : tempC < tempMin ? tempC - tempMin : 0;
  const rhDeviation = rhPct > rhMax ? rhPct - rhMax : rhPct < rhMin ? rhPct - rhMin : 0;

  let cause;
  if (tempOut && !rhOut) cause = 'temperatura';
  else if (rhOut && !tempOut) cause = 'umidade';
  else if (tempOut && rhOut) cause = tempContribution >= rhContribution ? 'temperatura_e_umidade_temp_principal' : 'temperatura_e_umidade_umidade_principal';
  else cause = 'combinacao'; // ambos dentro da propria faixa, mas a combinacao ainda nao fecha o VPD

  const causeMessages = {
    temperatura: `VPD ${direction} por causa da temperatura: está ${Math.abs(tempDeviation).toFixed(1)}°C ${tempDeviation > 0 ? 'acima' : 'abaixo'} da faixa ideal (${tempMin}–${tempMax}°C). Umidade está dentro da faixa.`,
    umidade: `VPD ${direction} por causa da umidade: está ${Math.abs(rhDeviation).toFixed(0)}% ${rhDeviation > 0 ? 'acima' : 'abaixo'} da faixa ideal (${rhMin}–${rhMax}%). Temperatura está dentro da faixa.`,
    temperatura_e_umidade_temp_principal: `VPD ${direction} — principalmente pela temperatura (${Math.abs(tempDeviation).toFixed(1)}°C ${tempDeviation > 0 ? 'acima' : 'abaixo'} do ideal), mas a umidade também está fora (${Math.abs(rhDeviation).toFixed(0)}% ${rhDeviation > 0 ? 'acima' : 'abaixo'}).`,
    temperatura_e_umidade_umidade_principal: `VPD ${direction} — principalmente pela umidade (${Math.abs(rhDeviation).toFixed(0)}% ${rhDeviation > 0 ? 'acima' : 'abaixo'} do ideal), mas a temperatura também está fora (${Math.abs(tempDeviation).toFixed(1)}°C ${tempDeviation > 0 ? 'acima' : 'abaixo'}).`,
    combinacao: `VPD ${direction} mesmo com temperatura e umidade dentro das próprias faixas — a combinação das duas ainda não fecha o VPD ideal. Considere apertar um pouco a faixa de temperatura ou de umidade.`
  };

  return {
    status: direction,
    cause,
    message: causeMessages[cause],
    actualVpd,
    tempDeviation: Math.round(tempDeviation * 10) / 10,
    rhDeviation: Math.round(rhDeviation)
  };
}

module.exports = { svp, airVPD, leafVPD, rhForTargetVPD, diagnoseVPD };
