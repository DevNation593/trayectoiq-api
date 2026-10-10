// Verifica que contract/fixtures/*.json coincide con lo que calcula el motor de referencia
// (contract/fixtures/reference_engine.py, aritmetica exacta, solo biblioteca estandar).
// Falla si alguien edita un fixture a mano o si la referencia y los fixtures se desincronizan.
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const script = join(repoRoot, 'contract', 'fixtures', 'reference_engine.py');

// En Linux y macOS el interprete suele llamarse python3; en Windows, python. En Windows
// "python3" puede existir como alias de la tienda que no ejecuta nada: por eso se sondea
// con --version en vez de fiarse de que el comando exista.
const python = ['python3', 'python'].find((candidate) => {
  const probe = spawnSync(candidate, ['--version'], { encoding: 'utf8' });
  return probe.status === 0 && /^Python 3\./.test(`${probe.stdout}${probe.stderr}`.trim());
});

if (!python) {
  console.error('fixtures:check necesita Python 3 (python3 o python) en el PATH.');
  process.exit(1);
}

// -I: modo aislado, no carga codigo del directorio actual ni variables PYTHON*.
const result = spawnSync(python, ['-I', script, '--check'], { stdio: 'inherit' });
if (result.error) {
  console.error(`No se pudo ejecutar ${python}: ${result.error.message}`);
  process.exit(1);
}
process.exit(result.status ?? 1);
