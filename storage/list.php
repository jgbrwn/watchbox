<?php
// watchbox origin file listing. Protected by Basic auth (.htaccess, or the Caddy config on a VPS).
// Returns every video/subtitle file under the library roots (config.php) as JSON.
// If any root is unreadable it returns 503 so the Worker never treats a broken mount as "everything was deleted".
// ?space=1 returns disk usage instead (see 'usage' in config.php).
declare(strict_types=1);
ignore_user_abort(true);
@set_time_limit(600);

$CFG = require __DIR__ . '/config.php';
define('ROOTS', $CFG['roots']);
define('PRIVATE_DIR', rtrim($CFG['private_dir'], '/'));
const EXT = '/\.(mp4|m4v|mkv|avi|mov|webm|ts|m2ts|mpg|mpeg|wmv|flv|divx|srt|ass|ssa|vtt)$/i';

header('Content-Type: application/json');
header('Cache-Control: private, no-store');

function usage_out(array $cfg): never {
  $u = $cfg['usage'] ?? ['type' => 'none'];
  $type = $u['type'] ?? 'none';
  $read = fn(string $f): string => trim((string)@file_get_contents(PRIVATE_DIR . '/' . basename($f)));
  $fetch = function (string $url, array $opts): array {
    $ch = curl_init($url);
    curl_setopt_array($ch, [CURLOPT_RETURNTRANSFER => true, CURLOPT_TIMEOUT => 20] + $opts);
    $body = (string)curl_exec($ch);
    $code = (int)curl_getinfo($ch, CURLINFO_RESPONSE_CODE);
    curl_close($ch);
    return [$code, $body];
  };
  if ($type === 'none') {   // the disk holding the library (cheap: no cache needed)
    $total = @disk_total_space($cfg['base']); $free = @disk_free_space($cfg['base']);
    if ($total === false || $free === false) { http_response_code(503); echo json_encode(['error' => 'disk space unavailable']); exit; }
    echo json_encode(['used_mb' => round(($total - $free) / 1048576), 'total_mb' => round($total / 1048576), 'at' => time(), 'source' => 'disk']);
    exit;
  }
  $cache = PRIVATE_DIR . '/usage.cache.json';
  if (is_file($cache) && time() - filemtime($cache) < 600) { readfile($cache); exit; }
  $url = rtrim((string)($u['url'] ?? ''), '/');
  if ($type === 'directadmin') {
    // A login key that may only run CMD_API_SHOW_USER_USAGE (see the storage docs).
    $key = $read($u['key_file'] ?? 'da-usage.key');
    if ($key === '' || $url === '') { http_response_code(503); echo json_encode(['error' => 'no key']); exit; }
    [$code, $body] = $fetch("$url/CMD_API_SHOW_USER_USAGE", [CURLOPT_USERPWD => ($u['user'] ?? '') . ":$key"]);
    parse_str($body, $d);
    if ($code !== 200 || !isset($d['quota'])) { http_response_code(502); echo json_encode(['error' => 'directadmin', 'status' => $code]); exit; }
    $out = ['used_mb' => (float)$d['quota'], 'inodes' => (int)($d['inode'] ?? 0), 'at' => time(), 'source' => 'directadmin'];
  } elseif ($type === 'cpanel') {
    $token = $read($u['token_file'] ?? 'cpanel.token');
    if ($token === '' || $url === '') { http_response_code(503); echo json_encode(['error' => 'no token']); exit; }
    [$code, $body] = $fetch("$url/execute/Quota/get_quota_info", [CURLOPT_HTTPHEADER => ['Authorization: cpanel ' . ($u['user'] ?? '') . ":$token"]]);
    $d = json_decode($body, true)['data'] ?? null;
    if ($code !== 200 || !isset($d['megabytes_used'])) { http_response_code(502); echo json_encode(['error' => 'cpanel', 'status' => $code]); exit; }
    $out = ['used_mb' => (float)$d['megabytes_used'], 'at' => time(), 'source' => 'cpanel'];
    if ((float)($d['megabyte_limit'] ?? 0) > 0) $out['total_mb'] = (float)$d['megabyte_limit'];
  } else { http_response_code(500); echo json_encode(['error' => 'unknown usage type']); exit; }
  $json = json_encode($out);
  @file_put_contents($cache, $json, LOCK_EX);
  @chmod($cache, 0600);
  echo $json;
  exit;
}
if (($_GET['space'] ?? '') === '1') usage_out($CFG);

$out = ['generated' => time(), 'roots' => [], 'files' => []];
foreach (ROOTS as $id => $root) {
  if (!is_dir($root) || !is_readable($root)) {
    http_response_code(503);
    echo json_encode(['error' => "root unavailable: $id"]);
    exit;
  }
  $count = 0;
  $it = new RecursiveIteratorIterator(
    new RecursiveDirectoryIterator($root, FilesystemIterator::SKIP_DOTS | FilesystemIterator::FOLLOW_SYMLINKS),
    RecursiveIteratorIterator::LEAVES_ONLY,
    RecursiveIteratorIterator::CATCH_GET_CHILD
  );
  foreach ($it as $path => $info) {
    if (!$info->isFile()) continue;
    $rel = substr($path, strlen($root) + 1);
    if ($rel === false || $rel === '' || preg_match('#(^|/)\.#', $rel)) continue;
    if (!preg_match(EXT, $rel)) continue;
    $out['files'][] = [$id, $rel, $info->getSize(), $info->getMTime(), $info->getInode()];
    $count++;
  }
  $out['roots'][$id] = $count;
}
echo json_encode($out, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE | JSON_INVALID_UTF8_SUBSTITUTE);
