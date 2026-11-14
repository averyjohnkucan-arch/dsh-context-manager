import {readdir} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
async function check(path) {for (const file of await readdir(path, {withFileTypes: true})) {
  if (['node_modules', '.git'].includes(file.name)) continue;
  const name = path + '/' + file.name;
  if (file.isDirectory()) await check(name);
  else if (/\.(m?js)$/.test(name)) {const result = spawnSync(process.execPath, ['--check', name], {stdio: 'inherit'}); if (result.status) process.exit(result.status);}
}}
await check('.');
