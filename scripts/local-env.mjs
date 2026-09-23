import { readFileSync } from 'node:fs';
import { parseEnv } from 'node:util';
import { resolve } from 'node:path';

/** Explicit launcher setting; config files cannot redirect subsequent config loads. */
export function localEnvironmentPath(root, environment = process.env) {
  const path = environment.INTERFACE_ENV_FILE?.trim() || '.env';
  if (path.includes('\0')) throw new Error('INTERFACE_ENV_FILE must be a filesystem path.');
  return resolve(root, path);
}

const supportedKeys = [
  ...['OPENAI', 'ANTHROPIC', 'GOOGLE', 'GEMINI'].flatMap(provider =>
    ['API_KEY', 'MODEL', 'BASE_URL'].map(setting => `${provider}_${setting}`)),
  'CHROME_PATH', 'WORKBENCH_PORT', 'TARGET_PORT', 'WORKBENCH_DATA_DIR',
  'INTERFACE_TARGET', 'MIFOS_URL', 'MIFOS_USERNAME', 'MIFOS_PASSWORD', 'MIFOS_TENANT',
  'MIFOS_COMPOSE_PROJECT', 'MIFOS_FIXTURE_DIR',
];

/** Project settings override inherited values without importing shell/runtime options. */
export function loadLocalEnv(path, environment = process.env) {
  let contents;
  try {
    contents = readFileSync(path, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') {
      if (environment.INTERFACE_ENV_FILE?.trim()) throw new Error('The explicitly selected INTERFACE_ENV_FILE does not exist. No default configuration was substituted.');
      return false;
    }
    throw error;
  }
  const local = parseEnv(contents);
  for (const key of supportedKeys) {
    // Presence, rather than truthiness, makes an explicit empty value clear an inherited one.
    if (Object.hasOwn(local, key)) environment[key] = local[key];
  }
  return true;
}
