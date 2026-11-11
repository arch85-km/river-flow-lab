<?php
/**
 * River Flow Lab — OpenStreetMap waterways proxy and cache
 *
 * Ported from Solar Analysis Lab's buildings proxy; only the query, the box
 * size and the names differ. The page asks this script, on its own site, for
 * the rivers and streams in a box; this script asks the public Overpass
 * servers and keeps the answer. Three things
 * follow from the browser never talking to Overpass itself:
 *
 *   - a network that blocks the Overpass servers (some university networks
 *     do), or a busy server that answers without a CORS header, no longer
 *     stops the rivers loading;
 *   - each answer is kept for 30 days, so a place loads once and is then
 *     instant for every visitor, even on a day when every public server is
 *     down. A stale answer is served rather than nothing when they all fail;
 *   - a class pressing "Find rivers here" together counts as one request to Overpass,
 *     not thirty from one shared address.
 *
 * No key and nothing secret: the data is OpenStreetMap's, under the ODbL.
 *
 * Install
 *   Upload next to index.html, in the same folder, or, where the host refuses
 *   to run PHP in subfolders (karam.me.uk answers 403 for any .php under
 *   /apps/), at the top of the site, e.g. public_html/overpass-proxy.php. The
 *   page looks in both places. Nothing to configure. It keeps its answers in a
 *   folder beside itself, overpass-cache/, which it creates and closes to
 *   direct access.
 *
 * Licence: MIT, same as the app's code. © 2026 Karam Al-Obaidi
 */
declare(strict_types=1);

/* ── configuration ─────────────────────────────────────────────────────── */

/** Public Overpass servers, asked in this order until one answers. */
$UPSTREAMS = [
    'https://overpass-api.de/api/interpreter',
    'https://overpass.private.coffee/api/interpreter',
    'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
];

/** How long an answer is served without asking Overpass again. */
$CACHE_DAYS = 30;

/** Where answers are kept. Beside this script, so it survives the server's
 *  temporary-file clean-ups. */
$CACHE_DIR = __DIR__ . '/overpass-cache';

/** Largest box side accepted, in metres. The app asks for at most 3,000 m;
 *  the margin allows for rounding at high latitudes. */
$MAX_SIDE_M = 3200;

/** Requests to Overpass one address may cause per hour. Answers from the cache
 *  do not count. Generous, because a computer lab usually reaches the web
 *  through one shared address. */
$MAX_FETCHES_PER_HOUR = 300;

/** Requests to Overpass all visitors together may cause per hour. A ceiling on
 *  the whole site, whatever addresses the requests come from: it keeps this
 *  server's use of the public Overpass service modest and its PHP workers free
 *  for the rest of the site. Past it, the page asks Overpass itself. */
$MAX_FETCHES_ALL_PER_HOUR = 1000;

/** Largest size of the kept answers, in megabytes. A new answer that takes the
 *  folder past it removes the oldest ones first, down to nine tenths. */
$CACHE_MAX_MB = 200;

/** Where the hour's counts are kept: the server's temporary folder, which is
 *  never served to the web. Nothing written there outlives its hour. */
$LIMIT_DIR = sys_get_temp_dir();

/** Seconds to wait for each server. The query itself allows Overpass 25 s. */
$CONNECT_TIMEOUT = 6;
$SERVER_TIMEOUT = 30;

/* ── helpers ───────────────────────────────────────────────────────────── */

/** End the request with a status and a short plain-text reason. */
function fail(int $code, string $why, ?int $retryAfter = null): void {
    http_response_code($code);
    header('Content-Type: text/plain; charset=utf-8');
    header('Cache-Control: no-store');
    if ($retryAfter !== null) header('Retry-After: ' . $retryAfter);
    echo $why;
    exit;
}

/** Host of a URL, or '' if it has none. */
function host_of(?string $url): string {
    if (!$url) return '';
    $h = parse_url($url, PHP_URL_HOST);
    return is_string($h) ? strtolower($h) : '';
}

/** Hand an answer to the browser. */
function answer(string $json, string $cache, string $source, int $ageSeconds): void {
    header('Content-Type: application/json; charset=utf-8');
    header('Content-Length: ' . strlen($json));
    // The browser may keep it for a day; the server-side copy is the real cache.
    header('Cache-Control: private, max-age=86400');
    header('X-Overpass-Cache: ' . $cache);
    header('X-Overpass-Source: ' . $source);
    header('X-Overpass-Age: ' . $ageSeconds);
    header('X-Content-Type-Options: nosniff');
    echo $json;
    exit;
}

/*
 * Answers are kept as .php files that begin with a line which ends any direct
 * request at once. SiteGround hands plain data files (.json) straight to the
 * web, bypassing .htaccess, so a kept answer was downloadable by anyone who had
 * its name; a .php file is run instead, and this one returns nothing.
 */
const GUARD = "<?php http_response_code(404); exit; ?>\n";

/** The answer kept in a cache file, without its guard line. */
function cached(string $path): string {
    $s = (string)@file_get_contents($path);
    return strncmp($s, GUARD, strlen(GUARD)) === 0 ? substr($s, strlen(GUARD)) : '';
}

/** Add one to a count kept in a file, holding the file while doing it. */
function bump(string $path): void {
    $fh = @fopen($path, 'c+');
    if (!$fh) return;
    flock($fh, LOCK_EX);
    $n = (int)stream_get_contents($fh);
    ftruncate($fh, 0);
    rewind($fh);
    fwrite($fh, (string)($n + 1));
    fflush($fh);
    flock($fh, LOCK_UN);
    fclose($fh);
}

/**
 * Keep the kept answers under $maxBytes: past it, remove the oldest first (the
 * least recently fetched) down to nine tenths, never the one just written.
 */
function trim_cache(string $dir, int $maxBytes, string $keep): void {
    $files = [];
    $total = 0;
    foreach ((array)glob($dir . '/*.php') as $f) {
        if (!is_string($f) || strpos(basename($f), '.tmp.') !== false) continue;
        $size = (int)@filesize($f);
        $files[] = [(int)@filemtime($f), $size, $f];
        $total += $size;
    }
    if ($total <= $maxBytes) return;
    sort($files);                                  // oldest first
    foreach ($files as [$when, $size, $f]) {
        if ($total <= $maxBytes * 0.9) break;
        if ($f === $keep) continue;
        if (@unlink($f)) {
            $total -= $size;
            @unlink(substr($f, 0, -4) . '.lock');
        }
    }
}

/** A usable Overpass answer: JSON with an elements list and no runtime error. */
function usable(string $body): bool {
    $j = json_decode($body, true);
    if (!is_array($j) || !isset($j['elements']) || !is_array($j['elements'])) return false;
    $remark = isset($j['remark']) && is_string($j['remark']) ? $j['remark'] : '';
    return stripos($remark, 'runtime error') === false;
}

/* ── only serve pages on this same host ────────────────────────────────── */

$self = strtolower((string)($_SERVER['HTTP_HOST'] ?? ''));
$self = preg_replace('/:\d+$/', '', $self);
$from = host_of($_SERVER['HTTP_ORIGIN'] ?? null) ?: host_of($_SERVER['HTTP_REFERER'] ?? null);

// The app and this script sit in the same folder, so the browser always sends a
// same-host Referer. A request without one is not from the page, and is refused
// rather than quietly allowed — otherwise this becomes an open relay.
if ($self === '' || $from === '' || $from !== $self) {
    fail(403, 'River requests are only accepted from pages on this site.');
}
if (($_SERVER['REQUEST_METHOD'] ?? 'GET') !== 'GET') fail(405, 'Use GET.');

/* ── validate the box ──────────────────────────────────────────────────── */

// south,west,north,east in degrees, as the app writes them (six decimals). Only
// a box is accepted, never a query: the query is written here, so the script
// cannot be used to run arbitrary Overpass requests.
$raw = (string)($_GET['bbox'] ?? '');
if (!preg_match('/^-?\d{1,2}\.\d{6},-?\d{1,3}\.\d{6},-?\d{1,2}\.\d{6},-?\d{1,3}\.\d{6}$/', $raw)) {
    fail(400, 'Expected bbox=south,west,north,east with six decimals.');
}
[$s, $w, $n, $e] = array_map('floatval', explode(',', $raw));
if ($s < -85 || $n > 85 || $s >= $n || $w < -180 || $e > 180 || $w >= $e) fail(400, 'Bad box.');
$sideNS = ($n - $s) * 111320;
$sideEW = ($e - $w) * 111320 * max(cos(deg2rad(($s + $n) / 2)), 0.05);
if ($sideNS > $MAX_SIDE_M || $sideEW > $MAX_SIDE_M) fail(400, 'Box too large.');

// Rivers, streams, canals, drains and ditches, drawn by OpenStreetMap in the
// direction of flow.
$query = '[out:json][timeout:25];way["waterway"~"^(river|stream|canal|drain|ditch)$"](' . $raw . '); out geom;';

/* ── the cache ─────────────────────────────────────────────────────────── */

if (!is_dir($CACHE_DIR)) {
    @mkdir($CACHE_DIR, 0755, true);
    // Close the folder to direct browsing where the server reads .htaccess. The
    // answers are public data, but the folder is this script's, not a download
    // area; the guard line (above) is what protects each file.
    @file_put_contents($CACHE_DIR . '/.htaccess', "Require all denied\nDeny from all\n");
    @file_put_contents($CACHE_DIR . '/index.html', '');
}
$key = sha1($raw);
$file = $CACHE_DIR . '/' . $key . '.php';
$maxAge = $CACHE_DAYS * 86400;

/* ── the hour's counts: delete everything from earlier hours ──────────── */

// Each visitor's fetches are counted for the current hour only (below). The
// counts and the key they are filed under go as soon as the hour is over,
// whoever asks next and whether or not the answer is already kept.
$hour = date('YmdH');
foreach ((array)glob($LIMIT_DIR . '/riverflowlab-overpass-*') as $old) {
    if (strpos(basename((string)$old), 'riverflowlab-overpass-' . $hour . '-') !== 0) @unlink((string)$old);
}

$age = is_file($file) ? time() - (int)filemtime($file) : null;
if ($age !== null && $age < $maxAge) {
    answer(cached($file), 'hit', 'cache', $age);
}

// One fetch per box at a time. Everyone else asking for the same box waits for
// it and is then served from the cache, so a class counts once.
$lock = @fopen($CACHE_DIR . '/' . $key . '.lock', 'c');
if ($lock) flock($lock, LOCK_EX);
clearstatcache(true, $file);
$age = is_file($file) ? time() - (int)filemtime($file) : null;
if ($age !== null && $age < $maxAge) {
    answer(cached($file), 'hit', 'cache', $age);
}

/* ── rate limit per visitor, for fetches only ──────────────────────────── */

// A count is filed under a keyed hash of the address, never the address or a
// plain hash of it: a plain hash of an IPv4 address is undone by trying all
// four billion. The key is random, made by the hour's first fetch, and deleted
// with the counts when the hour is over (above), after which no count can be
// traced back to anyone.
$limitKeyFile = $LIMIT_DIR . '/riverflowlab-overpass-' . $hour . '-key';
$limitKey = (string)@file_get_contents($limitKeyFile);
if (strlen($limitKey) !== 32) {
    $fresh = random_bytes(32);
    $fh = @fopen($limitKeyFile, 'x');              // only one request makes it
    if ($fh) {
        fwrite($fh, $fresh);
        fclose($fh);
        @chmod($limitKeyFile, 0600);
        $limitKey = $fresh;
    } else {
        usleep(50000);                              // another request is writing it
        $limitKey = (string)@file_get_contents($limitKeyFile);
        if (strlen($limitKey) !== 32) $limitKey = $fresh;
    }
}
$ip = (string)($_SERVER['REMOTE_ADDR'] ?? 'unknown');
$bucket = $LIMIT_DIR . '/riverflowlab-overpass-' . $hour . '-' . hash_hmac('sha256', $ip, $limitKey) . '.cnt';
// The whole site's count for the hour: a number and nothing else.
$allBucket = $LIMIT_DIR . '/riverflowlab-overpass-' . $hour . '-all.cnt';
if ((int)@file_get_contents($allBucket) >= $MAX_FETCHES_ALL_PER_HOUR) {
    if ($age !== null) answer(cached($file), 'stale', 'cache', $age);
    fail(429, 'This site\'s river requests for the hour are used up.', 600);
}
$count = (int)@file_get_contents($bucket);
if ($count >= $MAX_FETCHES_PER_HOUR) {
    if ($age !== null) answer(cached($file), 'stale', 'cache', $age);
    fail(429, 'River request limit reached for this hour.', 600);
}
@file_put_contents($bucket, (string)($count + 1), LOCK_EX);
bump($allBucket);

/* ── ask Overpass ──────────────────────────────────────────────────────── */

@set_time_limit(count($UPSTREAMS) * ($SERVER_TIMEOUT + $CONNECT_TIMEOUT) + 10);
$fwd = strtolower((string)($_SERVER['HTTP_X_FORWARDED_PROTO'] ?? ''));
$secure = $fwd !== '' ? $fwd === 'https'
        : (!empty($_SERVER['HTTPS']) && strtolower((string)$_SERVER['HTTPS']) !== 'off');
$agent = 'RiverFlowLab-overpass-proxy/1.0 (+' . ($secure ? 'https' : 'http') . '://' . $self . ')';

foreach ($UPSTREAMS as $url) {
    $ch = curl_init($url);
    curl_setopt_array($ch, [
        CURLOPT_POST           => true,
        CURLOPT_POSTFIELDS     => 'data=' . rawurlencode($query),
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_CONNECTTIMEOUT => $CONNECT_TIMEOUT,
        CURLOPT_TIMEOUT        => $SERVER_TIMEOUT,
        CURLOPT_FOLLOWLOCATION => false,
        CURLOPT_USERAGENT      => $agent,
        CURLOPT_HTTPHEADER     => ['Content-Type: application/x-www-form-urlencoded'],
    ]);
    $body = curl_exec($ch);
    $status = (int)curl_getinfo($ch, CURLINFO_RESPONSE_CODE);
    curl_close($ch);
    if ($status === 200 && is_string($body) && usable($body)) {
        // Written to a temporary name and moved, so a reader never sees half a file.
        $tmp = $CACHE_DIR . '/' . $key . '.' . getmypid() . '.tmp.php';
        if (@file_put_contents($tmp, GUARD . $body) !== false) @rename($tmp, $file);
        trim_cache($CACHE_DIR, (int)($CACHE_MAX_MB * 1048576), $file);
        // Now and then, drop answers nobody has refreshed in 90 days and their
        // locks, so the folder cannot grow without limit.
        if (mt_rand(1, 50) === 1) {
            foreach ((array)glob($CACHE_DIR . '/*') as $old) {
                if (!is_string($old)) continue;
                if (preg_match('/\.(json|php|lock)$/', $old) && time() - (int)@filemtime($old) > 90 * 86400) {
                    @unlink($old);
                }
            }
        }
        answer($body, 'miss', (string)parse_url($url, PHP_URL_HOST), 0);
    }
}

// Every server failed. An old answer is better than none: rivers rarely
// change within weeks, and the header says how old it is.
if ($age !== null) answer(cached($file), 'stale', 'cache', $age);
fail(503, 'The public Overpass servers did not answer. Try again in a minute.', 60);
