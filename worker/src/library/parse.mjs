// Filename/folder parsing for movie and TV files.
// Pure functions: given a root kind and a path relative to that root, return
// what the file most likely is. Matching against TMDB happens elsewhere.

export const VIDEO_EXT = new Set(['mp4', 'm4v', 'mkv', 'avi', 'mov', 'webm', 'ts', 'm2ts', 'mpg', 'mpeg', 'wmv', 'flv', 'divx']);
export const SUB_EXT = new Set(['srt', 'ass', 'ssa', 'vtt']);

const JUNK = new RegExp('^(' + [
  '\\d{3,4}p', '4k', 'uhd', 'hdr10?\\+?', 'hdr', 'dv', 'dovi', 'sdr', '10bit', '8bit', '12bit',
  'blu-?ray', 'bdrip', 'brrip', 'bdremux', 'remux', 'bd', 'web-?dl', 'webrip', 'web', 'hdtv', 'pdtv', 'dvdrip', 'dvd', 'dvdr', 'dvd9', 'dvd5',
  'hdrip', 'vhsrip', 'tvrip', 'satrip', 'dsr', 'hd', 'sd', 'fs', 'ws', 'r5', 'cam', 'ts', 'telesync',
  'x26[45]', 'h\\.?26[45]', 'hevc', 'avc', 'xvid', 'divx', 'mpeg2?', 'vc-?1', 'av1',
  'aac\\d?(\\.\\d)?', 'ac-?3', 'e-?ac-?3', 'ddp?\\d?(\\.\\d)?', 'dd\\+?', 'dts(-?hd)?', 'dts-?x', 'truehd', 'atmos', 'flac', 'mp3', 'opus', 'lpcm', 'pcm',
  '\\d\\.\\d', '\\dch', '[25]\\.[01]ch', 'stereo', 'mono',
  'proper', 'repack', 'rerip', 'internal', 'limited', 'complete', 'multi', 'dual', 'dl', 'subbed', 'dubbed', 'swesub', 'nordic', 'swedish', 'german', 'french', 'danish', 'norwegian', 'finnish', 'english', 'eng', 'ita', 'spa',
  'extended', 'unrated', 'uncut', 'remastered', 'theatrical', 'criterion', 'directors?', 'dc', 'imax', 'open ?matte', 'edition', 'restored', 'anniversary',
  'amzn', 'nf', 'hmax', 'dsnp', 'atvp', 'hulu', 'pcok', 'roku', 'itunes', 'max',
  'rarbg', 'yts', 'yify', 'eztv', 'ettv', 'psa', 'tigole', 'qxr', 'joy', 'galaxyrg', 'ion10', 'pahe'
].join('|') + ')$', 'i');

const EDITION = /\b(director'?s cut|directors cut|extended( (cut|edition|version))?|unrated( cut)?|theatrical( cut)?|special edition|anniversary edition|ultimate edition|collector'?s edition|final cut|uncut|remastered|criterion( collection)?|open matte|imax( edition)?|harder cut|tv edition)\b/ig;
const EXTRA_DIR = /^(extras?|featurettes?|behind[ ._-]the[ ._-]scenes|deleted[ ._-]scenes|interviews?|scenes|shorts?|trailers?|bonus( features)?|special[ ._-]features|other|making[ ._-]of|samples?)$/i;
const EXTRA_FILE = /([ ._-](trailer|featurette|behindthescenes|deleted[ ._-]?scene|interview|extra|making[ ._-]of)([ ._-]\d+)?$)|(^extra[ ._-]?\d+)/i;

export function splitExt(name) {
  const i = name.lastIndexOf('.');
  return i > 0 ? [name.slice(0, i), name.slice(i + 1).toLowerCase()] : [name, ''];
}

// "Two.Lane.Blacktop.1971.1080p" -> "Two Lane Blacktop 1971 1080p", keeping acronyms like S.O.B.
export function spaced(s) {
  s = s.replace(/\[[^\]]*\]/g, ' ').replace(/\{[^}]*\}/g, ' ');
  // Protect single-letter acronyms (S.O.B., L.A., U.S.) before turning dots into spaces.
  s = s.replace(/\b(?:[A-Za-z]\.){2,}/g, m => m.replace(/\./g, '\u0001') + ' ');
  s = s.replace(/[._]+/g, ' ').replace(/\u0001/g, '.');
  return s.replace(/\s+/g, ' ').trim();
}

function stripJunkTail(words) {
  const out = [];
  for (const w of words) {
    const bare = w.replace(/^[([{]+|[)\]}]+$/g, '');
    if (out.length && JUNK.test(bare)) break;
    out.push(w);
  }
  return out;
}

function cleanTitle(s) {
  return s.replace(EDITION, ' ').replace(/[([{]\s*[)\]}]/g, ' ')
    .replace(/\s*[-–:]\s*$/, '').replace(/^\s*[-–:]\s*/, '')
    .replace(/\s+/g, ' ').trim();
}

// Parse "Title (Year) junk" / "Title.Year.junk" / "Year - Title - junk" into {title, year}.
export function parseTitleYear(raw) {
  let s = spaced(raw).replace(/\(\s*(\d{4})\s*\)/g, ' $1 ').replace(/\{\s*(\d{4})\s*\)/g, ' $1 ');
  // "1985 - Shoah - AVI" (docu pack style)
  let m = /^((?:19|20)\d\d)\s+-\s+(.+?)(?:\s+-\s+(?:avi|mp4|mkv|dvd|xvid|wmv|divx|flv|mpg|mov))?$/i.exec(s);
  if (m) return { title: cleanTitle(stripJunkTail(m[2].split(' ')).join(' ')), year: +m[1] };
  const words = s.split(' ');
  let yearIdx = -1;
  for (let i = words.length - 1; i >= 1; i--) {
    const w = words[i].replace(/[()[\]]|[-–]+$/g, '');
    if (/^(19[0-9]\d|20[0-3]\d)$/.test(w)) {
      // Only treat as the release year if everything after is junk/edition words.
      yearIdx = i; break;
    }
  }
  let title, year = null;
  if (yearIdx > 0) {
    title = words.slice(0, yearIdx).join(' ');
    year = +words[yearIdx].replace(/[()[\]]|[-–]+$/g, '');
  } else {
    title = stripJunkTail(words).join(' ');
  }
  title = cleanTitle(stripJunkTail(title.split(' ')).join(' '));
  // Drop trailing release-group "-GROUP" left on the title.
  title = title.replace(/\s+-\s*$/, '').trim();
  return { title, year };
}

export function isSample(rel, size) {
  const parts = rel.split('/');
  if (parts.slice(0, -1).some(p => /^samples?$/i.test(p))) return true;
  const [base] = splitExt(parts.at(-1));
  return /(^|[ ._-])sample$/i.test(base) || (/(^|[ ._-])sample([ ._-]|$)/i.test(base) && (size ?? 0) < 400e6);
}

export function isExtra(rel, kind) {
  const parts = rel.split('/');
  const dirs = parts.slice(0, -1);
  if (dirs.some(p => EXTRA_DIR.test(p.trim()))) return true;
  const [base] = splitExt(parts.at(-1));
  return kind === 'movie' && EXTRA_FILE.test(base);
}

// Part/disc number for multi-file movies ("part1", "CD2", "Shoah 3").
function partNumber(base) {
  const m = /(?:^|[ ._-])(?:part|pt|cd|disc|disk|dvd)[ ._-]?(\d{1,2})(?:$|[ ._-])/i.exec(base);
  return m ? +m[1] : null;
}

export function parseMovie(rel, size) {
  const parts = rel.split('/');
  const [base, ext] = splitExt(parts.at(-1));
  const dirs = parts.slice(0, -1).filter(d => !/^(docu pack|movies?|films?)$/i.test(d));
  const kind = isSample(rel, size) ? 'sample' : isExtra(rel, 'movie') ? 'extra' : 'movie';
  // Candidate sources, best first: the innermost folder that carries a year,
  // then the filename, then any folder.
  const cands = [];
  for (const d of [...dirs].reverse()) cands.push({ src: 'dir', ...parseTitleYear(d) });
  cands.push({ src: 'file', ...parseTitleYear(base) });
  const usable = cands.filter(c => c.title && c.title.length >= 1 && !/^(season|disc|cd)\s*\d+$/i.test(c.title));
  const withYear = usable.filter(c => c.year);
  const best = withYear[0] || usable.find(c => c.src === 'dir') || usable[0] || { title: base, year: null };
  const alts = [];
  for (const c of usable) if (!alts.some(a => a.title.toLowerCase() === c.title.toLowerCase() && a.year === c.year)) alts.push({ title: c.title, year: c.year });
  return { kind, ext, title: best.title, year: best.year, part: partNumber(base), alts };
}

// ---------- TV ----------

const SEASON_DIR = /^(?:season|series|saison|staffel|s)[ ._-]*(\d{1,2})\b/i;

function episodeCoords(s) {
  let m;
  // S01E01, S01E01E02, S01E01-E02, S01 - E01, s3e15
  if ((m = /(?:^|[^a-z0-9])s(\d{1,2})[ ._-]*(?:-[ ._-]*)?e(\d{1,3})(?:(?:[ ._-]*-?[ ._-]*e|-)(\d{1,3}))?(?![0-9])/i.exec(s)) ||
      (m = /s(\d{1,2})e(\d{1,3})(?:-?e(\d{1,3}))?(?![0-9])/i.exec(s)))
    return { season: +m[1], episode: +m[2], episodeEnd: m[3] ? +m[3] : null };
  // 1x01, 01x01
  if ((m = /(?:^|[^a-z0-9])(\d{1,2})x(\d{2,3})(?:[-x](\d{2,3}))?(?![0-9])/i.exec(s)))
    return { season: +m[1], episode: +m[2], episodeEnd: m[3] ? +m[3] : null };
  // Season 3 Episode 01
  if ((m = /season[ ._-]*(\d{1,2})[ ._-]*(?:-[ ._-]*)?episode[ ._-]*(\d{1,3})/i.exec(s)))
    return { season: +m[1], episode: +m[2], episodeEnd: null };
  return null;
}

function episodeOnly(s) {
  let m;
  if ((m = /^(\d{1,3})(?:[ ._-]|$)/.exec(s))) return +m[1];
  if ((m = /(?:^|[^a-z0-9])(?:e|ep|episode)[ ._-]*(\d{1,3})(?![0-9])/i.exec(s))) return +m[1];
  if ((m = /(?:^|[^a-z0-9])(?:part|pt)[ ._-]*(\d{1,3})(?![0-9])/i.exec(s))) return +m[1];
  if ((m = /[ ._-]-[ ._-](\d{1,3})[ ._-]-[ ._-]/.exec(s))) return +m[1];
  return null;
}

// Series name from a release-style string: cut at SxxEyy / Sxx / junk / year.
export function seriesFromRelease(s) {
  let t = spaced(s);
  const cut = t.search(/(?:^|\s)(?:s\d{1,2}(?:e\d{1,3})?|\d{1,2}x\d{2,3}|season\s*\d+|complete|series\s*\d+)(?:\s|$|[-.])/i);
  if (cut > 0) t = t.slice(0, cut);
  let year = null;
  t = stripJunkTail(t.split(' ')).join(' ');
  const ym = /\s\(?((?:19|20)\d\d)\)?\s*$/.exec(t);
  if (ym) { year = +ym[1]; t = t.slice(0, ym.index); }
  t = cleanTitle(t).replace(/\s+aka\s+.*$/i, '');
  // "Gåsmamman SweSub" style tails
  return { title: t.replace(/\s+(dvd ?boxset|boxset|dvdrip).*$/i, '').trim(), year };
}

export function parseEpisode(rel, size) {
  const parts = rel.split('/');
  const [base, ext] = splitExt(parts.at(-1));
  const dirs = parts.slice(0, -1);
  let kind = isSample(rel, size) ? 'sample' : 'episode';
  if (kind === 'episode' && dirs.some(p => EXTRA_DIR.test(p.trim()))) kind = 'extra';
  const fileText = spaced(base);
  // Series: top-level folder, unless it is a release-style folder or the file sits at root.
  let series, seriesYear = null;
  if (dirs.length) {
    const r = seriesFromRelease(dirs[0]);
    series = r.title; seriesYear = r.year;
  } else {
    const r = seriesFromRelease(base);
    series = r.title; seriesYear = r.year;
  }
  if (!seriesYear && series) {
    // "Kin.2021.S02E01..." - a year right after the series name in the filename.
    const ym = /^(.*?)[ ._(-]+((?:19|20)\d\d)[ ._)-]+(?:s\d{1,2}e\d|\d{1,2}x\d)/i.exec(base);
    if (ym && normTitle(ym[1]) === normTitle(series)) seriesYear = +ym[2];
  }
  // Season from the nearest season-like folder.
  let folderSeason = null;
  for (const d of [...dirs].reverse()) {
    const m = SEASON_DIR.exec(d.trim()) || /(?:^|[ ._-])s(\d{1,2})(?:[ ._-]|$)/i.exec(d);
    if (m) { folderSeason = +m[1]; break; }
    if (/^specials?$/i.test(d.trim())) { folderSeason = 0; break; }
  }
  let coords = episodeCoords(base) || episodeCoords(fileText);
  let absolute = null;
  if (!coords) {
    // Remove a leading series name (punctuation-insensitive) before looking for a bare number.
    const words = (series || '').split(/[^\p{L}\p{N}]+/u).filter(Boolean).map(w => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
    const rest = words.length ? fileText.replace(new RegExp('^\\W*' + words.join('[^\\p{L}\\p{N}]*') + '[^\\p{L}\\p{N}]*', 'iu'), '') : fileText;
    const ep = episodeOnly(rest) ?? episodeOnly(fileText);
    if (ep != null && folderSeason != null) coords = { season: folderSeason, episode: ep, episodeEnd: null };
    else if (ep != null && /^\d{3}[ ._-]/.test(base) && folderSeason == null) absolute = ep; // e.g. NYPD "102-Weaver Of Hate"
    else if (ep != null && folderSeason == null) absolute = ep;
  }
  // Episode title text (for fuzzy matching when numbers are missing/ambiguous).
  let epTitle = fileText
    .replace(/(?:^|\s)(?:s\d{1,2}\s*-?\s*e\d{1,3}(?:\s*-?\s*e?\d{1,3})?|\d{1,2}x\d{2,3})(?=\s|$|-)/i, ' ')
    .replace(/^\d{1,3}\s*-\s*/, '');
  if (series) {
    // Strip the series name however it is punctuated ("Homicide - Life on the Street" vs "Homicide.Life.On.The.Street").
    const words = series.split(/[^\p{L}\p{N}]+/u).filter(Boolean).map(w => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
    if (words.length) epTitle = epTitle.replace(new RegExp('^\\W*' + words.join('[^\\p{L}\\p{N}]*') + '[^\\p{L}\\p{N}]*', 'iu'), '');
  }
  epTitle = cleanTitle(stripJunkTail(epTitle.replace(/^[\s-]+/, '').split(' ')).join(' ')).replace(/^-\s*/, '');
  if (epTitle && epTitle.split(' ').every(w => JUNK.test(w.replace(/^[([{]+|[)\]}]+$/g, '')) || /^[-\s]*$/.test(w))) epTitle = '';
  return { kind, ext, series, seriesYear, season: coords?.season ?? null, episode: coords?.episode ?? null,
    episodeEnd: coords?.episodeEnd ?? null, absolute, epTitle: epTitle || null };
}

export function parseFile(rootKind, rel, size) {
  return rootKind === 'tv' ? parseEpisode(rel, size) : parseMovie(rel, size);
}

export function normTitle(s) {
  return String(s || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/&/g, 'and').replace(/^(the|a|an)\s+/, '').replace(/[^a-z0-9]+/g, '');
}
