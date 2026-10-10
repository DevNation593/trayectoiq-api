// Copia el contrato desde trayectoiq-docs (fuente unica) a contract/.
//   node scripts/sync-contract.mjs           copia y registra el commit de origen
//   node scripts/sync-contract.mjs --check   falla si contract/ difiere de la fuente
// La ubicacion de la fuente se puede cambiar con TRAYECTOIQ_DOCS_DIR.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const FILES = [
  'openapi.yaml',
  'db/schema.sql',
  'fixtures/pricing-engine-golden.json',
  'fixtures/pricing-engine-invalid.json',
  'fixtures/reference_engine.py',
];

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const docsDir = resolve(repoRoot, process.env.TRAYECTOIQ_DOCS_DIR ?? '../Documentacion');
const contractDir = join(repoRoot, 'contract');
const checkOnly = process.argv.includes('--check');

const normalize = (text) => text.replace(/\r\n/g, '\n');

if (!existsSync(docsDir)) {
  if (checkOnly) {
    console.log(`contract:check omitido: no existe ${docsDir}`);
    process.exit(0);
  }
  console.error(`No existe la carpeta de documentacion: ${docsDir}`);
  process.exit(1);
}

const different = [];
for (const file of FILES) {
  const source = normalize(readFileSync(join(docsDir, file), 'utf8'));
  const target = join(contractDir, file);
  const current = existsSync(target) ? normalize(readFileSync(target, 'utf8')) : null;
  if (current === source) continue;
  different.push(file);
  if (!checkOnly) {
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, source);
  }
}

if (checkOnly) {
  if (different.length > 0) {
    console.error(`contract/ difiere de la fuente en: ${different.join(', ')}`);
    console.error('Ejecuta "pnpm contract:sync" y revisa el cambio.');
    process.exit(1);
  }
  console.log('contract/ coincide con la fuente.');
  process.exit(0);
}

let commit = 'desconocido';
try {
  commit = execFileSync('git', ['-C', docsDir, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
} catch {
  // La fuente puede no estar bajo git; el contrato se copia igual.
}
writeFileSync(
  join(contractDir, 'SOURCE.json'),
  `${JSON.stringify({ repository: 'trayectoiq-docs', commit, files: FILES }, null, 2)}\n`,
);
console.log(
  different.length > 0 ? `Actualizados: ${different.join(', ')}` : 'Sin cambios en los archivos.',
);
console.log(`Fuente: trayectoiq-docs@${commit}`);
