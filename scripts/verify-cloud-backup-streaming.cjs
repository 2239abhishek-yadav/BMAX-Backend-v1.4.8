const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const route = fs.readFileSync(path.join(root, 'src/routes/cloud-backup.routes.ts'), 'utf8');
const server = fs.readFileSync(path.join(root, 'src/server.ts'), 'utf8');
const phpFiles = [
  path.resolve(root, '../../HOSTINGER_UPLOAD/bmax-account-api.php'),
  path.resolve(root, '../../php-server/bmax-account-api.php'),
];
let failures = 0;
function check(name, ok) { console.log(`[CloudBackupStream] ${ok ? 'PASS' : 'FAIL'} ${name}`); if (!ok) failures++; }
check('Render upload forwards request stream', /body:\s*req\s+as any/.test(route));
check('Node fetch uses streaming duplex mode', /duplex:\s*'half'/.test(route));
check('Render upload no longer Base64-encodes SQLite Buffer', !/req\.body\.toString\(['"]base64['"]\)/.test(route));
check('Render server does not buffer cloud backup with express.raw', !/express\.raw\(\{\s*type:\s*'application\/x-bmax-cloud-backup'/.test(server));
for (const file of phpFiles) {
  const php = fs.readFileSync(file, 'utf8');
  check(`${path.basename(path.dirname(file))} PHP accepts binary stream headers`, /HTTP_X_BMAX_BACKUP_STREAM/.test(php) && /HTTP_X_BMAX_ACCOUNT_SESSION/.test(php));
  check(`${path.basename(path.dirname(file))} PHP validates SQLite header`, /SQLite format 3\\0/.test(php));
  check(`${path.basename(path.dirname(file))} PHP retains legacy Base64 clients`, /base64_decode\(\$encoded,true\)/.test(php));
}
process.exitCode = failures ? 1 : 0;
