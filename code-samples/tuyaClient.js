const crypto = require('crypto');

// Cliente enxuto para a Tuya OpenAPI (v1.0), seguindo o algoritmo de assinatura
// documentado em https://developer.tuya.com/en/docs/iot/new-singnature
// Toda a logica de assinatura fica isolada aqui -- o resto do sistema so chama
// metodos como getDeviceStatus() e sendCommands().
class TuyaClient {
  constructor({ accessId, accessSecret, baseUrl }) {
    // Antes isso lancava um erro na hora de CRIAR o cliente, o que derrubava
    // o servidor inteiro no boot se as credenciais estivessem vazias (ex: no
    // notebook de desenvolvimento, de proposito sem acesso a Tuya real). Agora
    // so marca como "nao configurado" e da erro (capturavel) na hora de USAR,
    // igual qualquer outra falha de leitura -- o resto do sistema continua
    // funcionando normalmente (diario, configuracoes, rastreabilidade, etc).
    this.configured = !!(accessId && accessSecret && baseUrl);
    this.accessId = accessId;
    this.accessSecret = accessSecret;
    this.baseUrl = (baseUrl || '').replace(/\/$/, '');
    this.token = null;
    this.tokenExpiresAt = 0;
  }

  sha256Hex(payload) {
    return crypto.createHash('sha256').update(payload || '', 'utf8').digest('hex');
  }

  hmacSign(str, key) {
    return crypto.createHmac('sha256', key).update(str, 'utf8').digest('hex').toUpperCase();
  }

  buildStringToSign(method, path, body) {
    const bodyHash = this.sha256Hex(body ? JSON.stringify(body) : '');
    // Headers assinados: nenhum extra usado aqui (string vazia na 3a linha)
    return [method, bodyHash, '', path].join('\n');
  }

  async ensureToken() {
    if (this.token && Date.now() < this.tokenExpiresAt) return this.token;

    const method = 'GET';
    const path = '/v1.0/token?grant_type=1';
    const t = Date.now().toString();
    const stringToSign = this.buildStringToSign(method, path, null);
    const sign = this.hmacSign(this.accessId + t + stringToSign, this.accessSecret);

    const res = await fetch(this.baseUrl + path, {
      method,
      headers: {
        client_id: this.accessId,
        sign,
        t,
        sign_method: 'HMAC-SHA256'
      }
    });
    const data = await res.json();
    if (!data.success) {
      throw new Error('Falha ao obter token Tuya: ' + JSON.stringify(data));
    }
    this.token = data.result.access_token;
    // renova 60s antes de expirar
    this.tokenExpiresAt = Date.now() + data.result.expire_time * 1000 - 60000;
    return this.token;
  }

  async request(method, path, body) {
    if (!this.configured) {
      throw new Error('Tuya nao configurada (TUYA_ACCESS_ID/TUYA_ACCESS_SECRET vazios no .env)');
    }
    const token = await this.ensureToken();
    const t = Date.now().toString();
    const stringToSign = this.buildStringToSign(method, path, body);
    const sign = this.hmacSign(this.accessId + token + t + stringToSign, this.accessSecret);

    const res = await fetch(this.baseUrl + path, {
      method,
      headers: {
        client_id: this.accessId,
        access_token: token,
        sign,
        t,
        sign_method: 'HMAC-SHA256',
        'Content-Type': 'application/json'
      },
      body: body ? JSON.stringify(body) : undefined
    });
    const data = await res.json();
    if (!data.success) {
      throw new Error(`Erro na API Tuya [${method} ${path}]: ` + JSON.stringify(data));
    }
    return data.result;
  }

  // ---- Dispositivos genericos (sensores, tomadas, interruptores) ----
  getDeviceStatus(deviceId) {
    return this.request('GET', `/v1.0/devices/${deviceId}/status`);
  }

  // IMPORTANTE: a Tuya cloud costuma responder com sucesso (200, dados
  // presentes) mesmo quando o dispositivo fisico esta offline -- ela devolve
  // a ULTIMA leitura conhecida, em cache, sem avisar que esta desatualizada.
  // Por isso "a chamada funcionou" nao significa "o sensor esta respondendo
  // agora". Esse endpoint devolve os detalhes do dispositivo, incluindo o
  // campo "online" de verdade -- e o unico jeito confiavel de saber.
  async getDeviceOnline(deviceId) {
    const info = await this.request('GET', `/v1.0/devices/${deviceId}`);
    return !!info.online;
  }

  sendCommands(deviceId, commands) {
    // commands: [{ code: 'switch_1', value: true }]
    return this.request('POST', `/v1.0/devices/${deviceId}/commands`, { commands });
  }

  // ---- Hub infravermelho (ar-condicionado) ----
  // IMPORTANTE (confirmado na documentacao oficial da Tuya): o endpoint
  // ".../air-conditioners/{remote}/command" e de COMANDO UNICO -- so aceita UM
  // par {code, value} por vez. Para mandar power+mode+temp+wind juntos, o
  // endpoint certo e ".../scenes/command". Usar o endpoint errado para varios
  // campos de uma vez gera erro genérico (ex: code 20001).
  //
  // O campo "mode" NAO aceita texto ("cold"/"hot") -- a Tuya espera um CODIGO
  // NUMERICO em string (ex: "0", "1", "4"), e esse numero varia por marca/
  // biblioteca de IR (nao ha padrao universal documentado publicamente). Use
  // getAcStatus() depois de mudar o modo manualmente pelo app/controle fisico
  // para descobrir, na pratica, qual numero corresponde a cada modo do SEU
  // aparelho -- e configure em config.acModeCodes (ou via .env).
  // Envia comandos ao AC via IR. Manda CADA campo como um comando unico e
  // sequencial (endpoint documentado e mais compativel entre bibliotecas de IR).
  // O endpoint de "cena" (varios campos de uma vez) exige uma biblioteca de
  // codigos que nem todo remoto tem associada -- por isso evitamos ele aqui.
  async sendAcCommand(infraredId, remoteId, { power, mode, temp, wind } = {}) {
    const results = {};
    if (power !== undefined) {
      results.power = await this.sendAcSingleCommand(infraredId, remoteId, 'power', power ? '1' : '0');
    }
    if (mode !== undefined) {
      results.mode = await this.sendAcSingleCommand(infraredId, remoteId, 'mode', mode);
    }
    if (temp !== undefined) {
      results.temp = await this.sendAcSingleCommand(infraredId, remoteId, 'temp', temp);
    }
    if (wind !== undefined) {
      results.wind = await this.sendAcSingleCommand(infraredId, remoteId, 'wind', wind);
    }
    return results;
  }

  // Consulta o ultimo estado conhecido do AC -- essencial para descobrir os
  // codigos numericos reais de "mode"/"wind" do seu aparelho: mude o modo pelo
  // controle fisico ou pelo app, chame isso, e veja o numero que aparece.
  // ATENCAO: para controles cadastrados por APRENDIZADO (nao por combinacao de
  // marca), este status pode nao refletir mudancas feitas no controle fisico --
  // infravermelho e via de mao unica, o hub so envia, nunca "le" o aparelho.
  getAcStatus(infraredId, remoteId) {
    return this.request('GET', `/v2.0/infrareds/${infraredId}/remotes/${remoteId}/ac/status`);
  }

  // Lista as teclas aprendidas/disponiveis num controle (essencial para controles
  // cadastrados por APRENDIZADO, onde a API de alto nivel de AC nao funciona).
  getRemoteKeys(infraredId, remoteId) {
    return this.request('GET', `/v2.0/infrareds/${infraredId}/remotes/${remoteId}/keys`);
  }

  // Envia UM comando isolado (code/value) -- usa o endpoint de comando unico
  // de verdade. Util para testar campo por campo (ex: so power, so mode).
  sendAcSingleCommand(infraredId, remoteId, code, value) {
    return this.request(
      'POST',
      `/v2.0/infrareds/${infraredId}/air-conditioners/${remoteId}/command`,
      { code, value: String(value) }
    );
  }

  // Envia uma tecla aprendida especifica (para controles cadastrados por
  // APRENDIZADO). categoryId e key (nome) vem da lista retornada por getRemoteKeys().
  sendRawKey(infraredId, remoteId, categoryId, key, keyId) {
    return this.request(
      'POST',
      `/v2.0/infrareds/${infraredId}/remotes/${remoteId}/raw/command`,
      { category_id: categoryId, key, key_id: keyId }
    );
  }
}

module.exports = TuyaClient;
