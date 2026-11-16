<?php
// Watch library management: move library files to a trash folder, restore them, empty the trash.
// Two locks: the vhost's Basic auth, plus an HMAC-SHA256 signature over the body with a key that only
// this file and the Worker know (<private_dir>/manage.key). Requests older
// than 5 minutes are refused. Only paths inside the library roots can be trashed, never symlinks,
// and nothing is ever deleted outright except by "purge", which only touches the trash folder.
declare(strict_types=1);
ignore_user_abort(true);
@set_time_limit(300);

$CFG = require __DIR__ . '/config.php';
define('BASE', rtrim($CFG['base'], '/'));
define('ROOTS', $CFG['roots']);
define('TRASH', BASE . '/.watch-trash');
define('PRIVATE_DIR', rtrim($CFG['private_dir'], '/'));
const VIDEO = '/\.(mp4|m4v|mkv|avi|mov|webm|ts|m2ts|mpg|mpeg|wmv|flv|divx|iso|rar)$/i';
// A folder left behind by a delete is trashed too, but only if what's left is small leftovers (nfo, jpg, txt).
const LEFTOVER_MAX_BYTES = 200 * 1048576;
const LEFTOVER_MAX_FILES = 200;
const BATCH_RE = '/^\d{8}-\d{6}-[0-9a-f]{6}$/';

header('Content-Type: application/json');
header('Cache-Control: private, no-store');

// First $len characters of a UTF-8 string (no mbstring needed).
function utf8_cut(string $s, int $start, int $len): string { return preg_match('/^.{0,' . $len . '}/us', $s, $m) ? $m[0] : substr($s, 0, $len); }

function out(int $code, array $d): never {
  http_response_code($code);
  echo json_encode($d, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE | JSON_INVALID_UTF8_SUBSTITUTE);
  exit;
}

if (($_SERVER['REQUEST_METHOD'] ?? '') !== 'POST') out(405, ['error' => 'POST only']);
$key = trim((string)@file_get_contents(PRIVATE_DIR . '/manage.key'));
if (strlen($key) < 32) out(503, ['error' => 'not configured']);
$body = (string)file_get_contents('php://input', false, null, 0, 1 << 20);
$sig = (string)($_SERVER['HTTP_X_WATCH_SIGNATURE'] ?? '');
if (!hash_equals('sha256=' . hash_hmac('sha256', $body, $key), $sig)) out(401, ['error' => 'bad signature']);
$req = json_decode($body, true);
if (!is_array($req)) out(400, ['error' => 'bad json']);
if (abs(time() - (int)($req['ts'] ?? 0)) > 300) out(401, ['error' => 'stale request']);

// ---------- helpers ----------

function base_real(): string { static $b; return $b ??= (string)realpath(BASE); }

/** Absolute path of a library file, or an error string. */
function library_path(mixed $root, mixed $rel): array {
  if (!is_string($root) || !isset(ROOTS[$root])) return [null, 'unknown root'];
  if (!is_string($rel) || $rel === '' || str_contains($rel, "\0") || $rel[0] === '/' || preg_match('#(^|/)\.\.?(/|$)#', $rel))
    return [null, 'bad path'];
  return [ROOTS[$root] . '/' . $rel, null];
}

/** True if $path's folder really is inside the data folder (no symlinked folders leading elsewhere). */
function inside_base(string $path): bool {
  $dir = realpath(dirname($path));
  return $dir !== false && str_starts_with($dir . '/', base_real() . '/');
}

function ensure_dir(string $dir): void {
  if (!is_dir($dir) && !mkdir($dir, 0700, true) && !is_dir($dir)) throw new RuntimeException("cannot create $dir");
}

/** [has video, bytes, files] for a folder, without following symlinks. */
function folder_summary(string $dir): array {
  $bytes = 0; $files = 0;
  $it = new RecursiveIteratorIterator(new RecursiveDirectoryIterator($dir, FilesystemIterator::SKIP_DOTS), RecursiveIteratorIterator::LEAVES_ONLY, RecursiveIteratorIterator::CATCH_GET_CHILD);
  foreach ($it as $p => $info) {
    if (preg_match(VIDEO, $p)) return [true, $bytes, $files];
    $files++;
    if ($info->isFile() && !$info->isLink()) $bytes += $info->getSize();
    if ($files > LEFTOVER_MAX_FILES) break;
  }
  return [false, $bytes, $files];
}

/** Deletes a folder inside the trash, never following symlinks. */
function rmtree(string $dir): void {
  $real = realpath($dir);
  $trash = realpath(TRASH);
  if ($real === false || $trash === false || !str_starts_with($real, $trash . '/')) throw new RuntimeException('refusing to delete outside the trash');
  $it = new RecursiveIteratorIterator(new RecursiveDirectoryIterator($real, FilesystemIterator::SKIP_DOTS), RecursiveIteratorIterator::CHILD_FIRST);
  foreach ($it as $p => $info) {
    if ($info->isDir() && !$info->isLink()) rmdir($p); else unlink($p);
  }
  rmdir($real);
}

/** Moves $from back to $to; if a folder already exists there, merges into it. Returns conflicting paths. */
function put_back(string $from, string $to): array {
  if (!file_exists($from) && !is_link($from)) return [];
  if (!file_exists($to) && !is_link($to)) { ensure_dir(dirname($to)); return @rename($from, $to) ? [] : [$to]; }
  if (!is_dir($from) || is_link($from) || !is_dir($to) || is_link($to)) return [$to];
  $conflicts = [];
  foreach (scandir($from) as $c) if ($c !== '.' && $c !== '..') array_push($conflicts, ...put_back("$from/$c", "$to/$c"));
  @rmdir($from);
  return $conflicts;
}

function manifest(string $batch): ?array {
  $m = json_decode((string)@file_get_contents(TRASH . "/$batch/manifest.json"), true);
  return is_array($m) ? $m : null;
}

function write_manifest(string $batch, array $m): void {
  file_put_contents(TRASH . "/$batch/manifest.json", json_encode($m, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE | JSON_PRETTY_PRINT), LOCK_EX);
}

function batch_bytes(string $batch): int {
  $n = 0;
  $dir = TRASH . "/$batch";
  if (!is_dir($dir)) return 0;
  $seen = [];   // hard links of one file count once
  $it = new RecursiveIteratorIterator(new RecursiveDirectoryIterator($dir, FilesystemIterator::SKIP_DOTS));
  foreach ($it as $info) {
    if (!$info->isFile() || $info->isLink() || isset($seen[$info->getInode()])) continue;
    $seen[$info->getInode()] = true;
    $n += $info->getSize();
  }
  return $n;
}

function forget_usage_cache(): void { @unlink(PRIVATE_DIR . '/usage.cache.json'); @unlink(PRIVATE_DIR . '/da-usage.cache.json'); }

// ---------- operations ----------

$op = $req['op'] ?? '';

if ($op === 'trash') {
  $paths = $req['paths'] ?? null;
  if (!is_array($paths) || !$paths || count($paths) > 2000) out(400, ['error' => 'paths must be a non-empty list']);
  $todo = []; $gone = []; $errors = [];
  foreach ($paths as $p) {
    [$abs, $err] = library_path($p[0] ?? null, $p[1] ?? null);
    if ($err) { $errors[] = ['path' => $p, 'error' => $err]; continue; }
    if (is_link($abs)) { $errors[] = ['path' => $p, 'error' => 'is a symlink']; continue; }
    if (!file_exists($abs)) { $gone[] = $p; continue; }
    if (!is_file($abs)) { $errors[] = ['path' => $p, 'error' => 'not a file']; continue; }
    if (!inside_base($abs)) { $errors[] = ['path' => $p, 'error' => 'outside the library folder']; continue; }
    $todo[$p[0] . "\0" . $p[1]] = [$p[0], $p[1], $abs];
  }
  if ($errors) out(400, ['error' => 'some paths were refused; nothing was moved', 'refused' => $errors]);
  if (!$todo) out(200, ['batch' => null, 'moved' => [], 'gone' => $gone]);

  $batch = date('Ymd-His') . '-' . bin2hex(random_bytes(3));
  $dir = TRASH . "/$batch";
  ensure_dir($dir);
  @chmod(TRASH, 0700);
  $moved = [];
  foreach ($todo as [$root, $rel, $abs]) {
    $dest = "$dir/files/$root/$rel";
    $size = filesize($abs);
    $ok = true;
    try { ensure_dir(dirname($dest)); } catch (RuntimeException $e) { $ok = false; }
    if ($ok && @rename($abs, $dest)) { $moved[] = ['root' => $root, 'rel' => $rel, 'size' => $size, 'inode' => fileinode($dest)]; continue; }
    // Put back what was already moved, so a failure leaves the library as it was.
    foreach (array_reverse($moved) as $m) @rename("$dir/files/{$m['root']}/{$m['rel']}", ROOTS[$m['root']] . '/' . $m['rel']);
    rmtree($dir);
    out(500, ['error' => "could not move $root/$rel; nothing was changed"]);
  }

  // Leftover folders (only small non-video files remain): trash them too, walking up towards the root.
  $folders = [];
  $dirs = [];
  foreach ($moved as $m) { $d = dirname($m['rel']); if ($d !== '.') $dirs[$m['root'] . "\0" . $d] = [$m['root'], $d]; }
  uasort($dirs, fn($a, $b) => substr_count($b[1], '/') <=> substr_count($a[1], '/'));
  foreach ($dirs as [$root, $rel]) {
    // Find the highest folder that holds nothing but small leftovers, then move it once.
    $top = null;
    while ($rel !== '.' && $rel !== '') {
      $abs = ROOTS[$root] . '/' . $rel;
      if (!is_dir($abs) || is_link($abs) || !inside_base($abs . '/x')) break;
      [$video, $bytes, $files] = folder_summary($abs);
      if ($video || $bytes > LEFTOVER_MAX_BYTES || $files > LEFTOVER_MAX_FILES) break;
      $top = [$rel, $bytes, $files];
      $rel = dirname($rel);
    }
    if (!$top) continue;
    $dest = "$dir/folders/$root/{$top[0]}";
    ensure_dir(dirname($dest));
    if (@rename(ROOTS[$root] . '/' . $top[0], $dest)) $folders[] = ['root' => $root, 'rel' => $top[0], 'bytes' => $top[1], 'files' => $top[2]];
  }

  // Space is only freed when no other hard link to the same data remains outside the trash.
  $inTrash = [];
  foreach ($moved as $m) $inTrash[$m['inode']] = ($inTrash[$m['inode']] ?? 0) + 1;
  $frees = 0; $linked = [];
  $seen = [];
  foreach ($moved as &$m) {
    $links = (int)(@stat("$dir/files/{$m['root']}/{$m['rel']}")['nlink'] ?? 1);
    $m['linked_elsewhere'] = $links > $inTrash[$m['inode']];
    if ($m['linked_elsewhere']) $linked[] = "{$m['root']}/{$m['rel']}";
    elseif (!isset($seen[$m['inode']])) $frees += $m['size'];
    $seen[$m['inode']] = true;
  }
  unset($m);
  $man = ['batch' => $batch, 'at' => time(), 'label' => utf8_cut((string)($req['label'] ?? ''), 0, 300),
          'files' => $moved, 'folders' => $folders, 'frees' => $frees, 'linked_elsewhere' => $linked, 'gone' => $gone];
  write_manifest($batch, $man);
  out(200, $man);
}

if ($op === 'list') {
  $batches = [];
  if (is_dir(TRASH)) foreach (scandir(TRASH) as $b) {
    if (!preg_match(BATCH_RE, $b) || !($m = manifest($b))) continue;
    $m['bytes'] = batch_bytes($b);
    $batches[] = $m;
  }
  usort($batches, fn($a, $b) => $b['at'] <=> $a['at']);
  out(200, ['batches' => $batches]);
}

if ($op === 'restore') {
  $batch = (string)($req['batch'] ?? '');
  if (!preg_match(BATCH_RE, $batch) || !($m = manifest($batch))) out(404, ['error' => 'no such trash entry']);
  $dir = TRASH . "/$batch";
  $restored = []; $conflicts = [];
  // Folders first so the files' folders exist again; an existing folder is merged into, never replaced.
  foreach (array_reverse($m['folders']) as $f) {
    $c = put_back("$dir/folders/{$f['root']}/{$f['rel']}", ROOTS[$f['root']] . '/' . $f['rel']);
    if ($c) array_push($conflicts, ...$c); else $restored[] = "{$f['root']}/{$f['rel']}/";
  }
  foreach ($m['files'] as $f) {
    $from = "$dir/files/{$f['root']}/{$f['rel']}";
    if (!file_exists($from)) continue;
    $c = put_back($from, ROOTS[$f['root']] . '/' . $f['rel']);
    if ($c) array_push($conflicts, ...$c); else $restored[] = "{$f['root']}/{$f['rel']}";
  }
  $conflicts = array_map(fn($p) => preg_replace('#^' . preg_quote(BASE, '#') . '/#', '', $p), $conflicts);
  if (!$conflicts) rmtree($dir);
  out(200, ['restored' => $restored, 'conflicts' => $conflicts]);
}

if ($op === 'purge') {
  // One batch, or every batch older than older_than seconds.
  $batch = (string)($req['batch'] ?? '');
  $older = (int)($req['older_than'] ?? 0);
  $purged = []; $bytes = 0;
  if ($batch !== '') {
    if (!preg_match(BATCH_RE, $batch) || !is_dir(TRASH . "/$batch")) out(404, ['error' => 'no such trash entry']);
    $bytes += batch_bytes($batch); rmtree(TRASH . "/$batch"); $purged[] = $batch;
  } elseif ($older > 0 && is_dir(TRASH)) {
    foreach (scandir(TRASH) as $b) {
      if (!preg_match(BATCH_RE, $b)) continue;
      $at = (int)(manifest($b)['at'] ?? filemtime(TRASH . "/$b"));
      if (time() - $at < $older) continue;
      $bytes += batch_bytes($b); rmtree(TRASH . "/$b"); $purged[] = $b;
    }
  } else out(400, ['error' => 'batch or older_than required']);
  if ($purged) forget_usage_cache();
  out(200, ['purged' => $purged, 'bytes' => $bytes]);
}

out(400, ['error' => 'unknown op']);
