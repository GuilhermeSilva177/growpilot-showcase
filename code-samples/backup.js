const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');

const DATA_DIR = path.join(__dirname, '..', 'data');
const BACKUP_DIR = path.join(__dirname, '..', 'data-backups');
const KEEP_LAST_N = 14; // mantem os ultimos 14 backups (ex: ~2 semanas se for 1/dia)

// Copias extras FORA da pasta do projeto (ex: pasta sincronizada do OneDrive /
// Google Drive e/ou pendrive/HD externo). Configure no .env:
//   BACKUP_EXTRA_DIRS=C:\Users\Fulano\OneDrive\GrowPilotBackups;E:\GrowPilotBackups
// (separe varias pastas com ponto e virgula). Se o pendrive nao estiver
// conectado na hora, aquele destino falha e o sistema avisa, sem travar nada.
function extraDirs() {
  return String(process.env.BACKUP_EXTRA_DIRS || '')
    .split(';')
    .map((s) => s.trim())
    .filter(Boolean);
}

const status = { lastRunAt: null, lastFile: null, lastError: null, destinations: [] };

function ensureBackupDir() {
  if (!fs.existsSync(BACKUP_DIR)) fs.mkdirSync(BACKUP_DIR, { recursive: true });
}

function timestampForFilename(date) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}_${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

// Roda "tar" (vem por padrao no Windows 10+, macOS e Linux -- nao precisa
// instalar nada) para compactar a pasta data/ inteira num arquivo .tar.gz
function runBackup() {
  return new Promise((resolve, reject) => {
    if (!fs.existsSync(DATA_DIR)) {
      return reject(new Error('Pasta data/ nao existe ainda -- nada para fazer backup'));
    }
    ensureBackupDir();
    const filename = `backup-${timestampForFilename(new Date())}.tar.gz`;
    const outputPath = path.join(BACKUP_DIR, filename);

    // -C muda para a pasta do projeto antes de compactar, para o backup
    // guardar so "data/..." e nao o caminho completo do seu computador
    const cmd = `tar -czf "${outputPath}" -C "${path.join(__dirname, '..')}" data`;

    exec(cmd, (error, stdout, stderr) => {
      if (error) {
        return reject(new Error(`Falha ao rodar tar (verifique se esta instalado): ${error.message}`));
      }
      pruneOldBackups();
      const destinations = copyToExtraDirs(outputPath, filename);
      status.lastRunAt = new Date().toISOString();
      status.lastFile = filename;
      status.lastError = null;
      status.destinations = destinations;
      const failed = destinations.filter((d) => !d.ok);
      if (failed.length) {
        try {
          require('./alerts').sendAlertAsync(
            'backup_extra_fail',
            `⚠️ O backup foi feito no PC, mas NÃO foi copiado para: ${failed.map((d) => d.dir + ' (' + d.error + ')').join('; ')}. Confira se o pendrive/pasta sincronizada está disponível.`
          );
        } catch (e) { /* melhor esforco */ }
      }
      resolve({ file: filename, path: outputPath, at: status.lastRunAt, destinations });
    });
  });
}

function pruneDir(dir) {
  const files = fs
    .readdirSync(dir)
    .filter((f) => f.startsWith('backup-') && f.endsWith('.tar.gz'))
    .map((f) => ({ name: f, time: fs.statSync(path.join(dir, f)).mtimeMs }))
    .sort((a, b) => b.time - a.time);
  files.slice(KEEP_LAST_N).forEach((f) => {
    try { fs.unlinkSync(path.join(dir, f.name)); } catch (e) { /* melhor esforco */ }
  });
}

function copyToExtraDirs(srcPath, filename) {
  return extraDirs().map((dir) => {
    try {
      // Cria so a ULTIMA pasta, e so se a pasta-mae existir. Assim, pendrive
      // desconectado (letra E: inexistente) vira erro claro em vez de criar lixo.
      if (!fs.existsSync(dir)) {
        if (!fs.existsSync(path.dirname(dir))) throw new Error('unidade/pasta-mae nao encontrada');
        fs.mkdirSync(dir);
      }
      fs.copyFileSync(srcPath, path.join(dir, filename));
      pruneDir(dir);
      return { dir, ok: true };
    } catch (e) {
      return { dir, ok: false, error: e.code || e.message };
    }
  });
}

function pruneOldBackups() {
  ensureBackupDir();
  const files = fs
    .readdirSync(BACKUP_DIR)
    .filter((f) => f.startsWith('backup-') && f.endsWith('.tar.gz'))
    .map((f) => ({ name: f, time: fs.statSync(path.join(BACKUP_DIR, f)).mtimeMs }))
    .sort((a, b) => b.time - a.time);

  files.slice(KEEP_LAST_N).forEach((f) => {
    try {
      fs.unlinkSync(path.join(BACKUP_DIR, f.name));
    } catch (e) { /* melhor esforco */ }
  });
}

function listBackups() {
  ensureBackupDir();
  return fs
    .readdirSync(BACKUP_DIR)
    .filter((f) => f.startsWith('backup-') && f.endsWith('.tar.gz'))
    .map((f) => {
      const stat = fs.statSync(path.join(BACKUP_DIR, f));
      return { file: f, sizeBytes: stat.size, at: stat.mtime.toISOString() };
    })
    .sort((a, b) => new Date(b.at) - new Date(a.at));
}

// Agenda o backup para rodar 1x por dia (roda uma vez no boot tambem, pra
// garantir que sempre existe pelo menos um backup recente)
function alertBackupFailure(e, where) {
  try {
    require('./alerts').sendAlertAsync('backup_failed', `🚨 O backup automático FALHOU (${where}): ${e.message}\n\nSem backup recente seus dados ficam sem proteção. Confira o espaço em disco e as pastas de BACKUP_EXTRA_DIRS.`);
  } catch (err) { /* melhor esforco */ }
}

// Se o ultimo backup bem sucedido ficou velho demais (>30h), avisa -- pega o caso
// de o servidor ficar ligado mas o backup parar de rodar sem erro visivel.
function checkStale() {
  const list = listBackups();
  const last = list.length ? new Date(list[0].at).getTime() : 0;
  if (!last || Date.now() - last > 30 * 3600 * 1000) {
    try {
      require('./alerts').sendAlertAsync('backup_stale', '⚠️ Não há backup recente (mais de 30 h). O backup diário pode ter parado — confira o sistema.');
    } catch (err) { /* melhor esforco */ }
  }
}

function scheduleDailyBackup() {
  runBackup().catch((e) => { console.error('[backup] falhou no boot:', e.message); alertBackupFailure(e, 'ao iniciar'); });
  const ONE_DAY_MS = 24 * 60 * 60 * 1000;
  setInterval(() => {
    runBackup().catch((e) => { console.error('[backup] falhou:', e.message); alertBackupFailure(e, 'rotina diária'); });
  }, ONE_DAY_MS);
  setInterval(checkStale, 6 * 60 * 60 * 1000);
}

function getStatus() {
  return {
    ...status,
    extraDirsConfigured: extraDirs(),
    keepLast: KEEP_LAST_N,
    backups: listBackups()
  };
}

// Restaurar: SEMPRE faz um backup de seguranca do estado atual antes, valida o
// arquivo escolhido (so aceita nomes backup-*.tar.gz da pasta de backups),
// extrai numa pasta temporaria e so entao troca a pasta data/. Depois disso o
// servidor precisa reiniciar para recarregar tudo da memoria.
function restoreBackup(file) {
  return new Promise((resolve, reject) => {
    if (!/^backup-[0-9_-]+\.tar\.gz$/.test(String(file || ''))) return reject(new Error('Nome de backup invalido'));
    const src = path.join(BACKUP_DIR, file);
    if (!fs.existsSync(src)) return reject(new Error('Backup nao encontrado'));
    const tmp = path.join(__dirname, '..', 'data-restore-tmp');
    fs.rmSync(tmp, { recursive: true, force: true });
    fs.mkdirSync(tmp, { recursive: true });
    exec(`tar -xzf "${src}" -C "${tmp}"`, async (error) => {
      try {
        if (error) throw new Error('Falha ao abrir o backup: ' + error.message);
        const extracted = path.join(tmp, 'data');
        if (!fs.existsSync(extracted) || !fs.statSync(extracted).isDirectory()) throw new Error('Arquivo de backup nao contem a pasta data/');
        // snapshot de seguranca do estado atual (nome proprio, nao entra na rotacao normal de 14)
        let safety = null;
        if (fs.existsSync(DATA_DIR)) {
          const r = await runBackup();
          safety = r.file;
        }
        const old = path.join(__dirname, '..', 'data-before-restore');
        fs.rmSync(old, { recursive: true, force: true });
        if (fs.existsSync(DATA_DIR)) fs.renameSync(DATA_DIR, old);
        fs.renameSync(extracted, DATA_DIR);
        fs.rmSync(tmp, { recursive: true, force: true });
        resolve({ restored: file, safetyBackup: safety, previousDataKeptAt: 'data-before-restore' });
      } catch (e) {
        fs.rmSync(tmp, { recursive: true, force: true });
        reject(e);
      }
    });
  });
}

module.exports = { runBackup, listBackups, scheduleDailyBackup, getStatus, restoreBackup };
