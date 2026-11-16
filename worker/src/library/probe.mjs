// Lightweight container probing over byte ranges (MP4/MOV, Matroska/WebM, AVI).
// reader(offset, length) -> Promise<Uint8Array>. Returns
// { container, durationTicks, bitrate, streams: [{type, codec, ...}] }.

const TICKS = 10_000_000;

export async function probeFile(reader, ext) {
  const head = await reader(0, 512 * 1024);
  const tag = ascii(head, 0, 4);
  if (tag === '\x1aE\xdf\xa3') return probeMkv(reader, head);
  if (tag === 'RIFF' && ascii(head, 8, 4) === 'AVI ') return probeAvi(head);
  if (ascii(head, 4, 4) === 'ftyp' || ['moov', 'mdat', 'free', 'wide', 'skip'].includes(ascii(head, 4, 4))) return probeMp4(reader, head);
  if (head[0] === 0x47 || head[4] === 0x47) return { container: ext === 'm2ts' ? 'm2ts' : 'ts', streams: [] };
  throw new Error(`unrecognized container (${ext})`);
}

function ascii(b, o, n) { let s = ''; for (let i = 0; i < n && o + i < b.length; i++) s += String.fromCharCode(b[o + i]); return s; }
const u16 = (b, o) => (b[o] << 8) | b[o + 1];
const u32 = (b, o) => ((b[o] << 24) >>> 0) + (b[o + 1] << 16) + (b[o + 2] << 8) + b[o + 3];
const u64 = (b, o) => u32(b, o) * 2 ** 32 + u32(b, o + 4);
const le16 = (b, o) => b[o] | (b[o + 1] << 8);
const le32 = (b, o) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16)) + b[o + 3] * 2 ** 24;

// ---------------- MP4 ----------------

const MP4_CODEC = { avc1: 'h264', avc3: 'h264', hvc1: 'hevc', hev1: 'hevc', mp4v: 'mpeg4', av01: 'av1', vp09: 'vp9', 'mp4a': 'aac', 'ac-3': 'ac3', 'ec-3': 'eac3', opus: 'opus', fLaC: 'flac', '.mp3': 'mp3', tx3g: 'mov_text', 'c608': 'eia_608', wvtt: 'webvtt' };

async function probeMp4(reader, head) {
  let off = 0, buf = head, base = 0, moov = null;
  for (let hops = 0; hops < 50 && !moov; hops++) {
    if (off - base + 16 > buf.length) { buf = await reader(off, 64 * 1024); base = off; if (buf.length < 8) break; }
    const p = off - base;
    let size = u32(buf, p); const type = ascii(buf, p + 4, 4);
    if (size === 1) size = u64(buf, p + 8);
    if (type === 'moov') {
      const want = Math.min(size, 16 * 1024 * 1024);
      moov = p + want <= buf.length ? buf.subarray(p, p + want) : await reader(off, want);
      break;
    }
    if (size < 8) break;
    off += size;
  }
  if (!moov) throw new Error('mp4: moov not found');
  const out = { container: 'mp4', streams: [] };
  const kids = (b, start, end, fn) => { for (let o = start; o + 8 <= end;) { let s = u32(b, o); const t = ascii(b, o + 4, 4); let h = 8; if (s === 1) { s = u64(b, o + 8); h = 16; } if (s < 8 || o + s > end + 8) s = end - o; fn(t, o + h, Math.min(o + s, end)); o += s; } };
  kids(moov, 8, moov.length, (t, s, e) => {
    if (t === 'mvhd') {
      const v = moov[s];
      const scale = v === 1 ? u32(moov, s + 20) : u32(moov, s + 12);
      const dur = v === 1 ? u64(moov, s + 24) : u32(moov, s + 16);
      if (scale) out.durationTicks = Math.round((dur / scale) * TICKS);
    }
    if (t === 'trak') {
      const st = {};
      kids(moov, s, e, (t2, s2, e2) => {
        if (t2 === 'tkhd') { const v = moov[s2]; const wo = v === 1 ? 88 : 76; st.width = u32(moov, s2 + wo) >>> 16; st.height = u32(moov, s2 + wo + 4) >>> 16; }
        if (t2 === 'mdia') kids(moov, s2, e2, (t3, s3, e3) => {
          if (t3 === 'mdhd') { const v = moov[s3]; const lo = v === 1 ? s3 + 32 : s3 + 20; const l = u16(moov, lo); st.language = String.fromCharCode(((l >> 10) & 31) + 96, ((l >> 5) & 31) + 96, (l & 31) + 96); }
          if (t3 === 'hdlr') st.handler = ascii(moov, s3 + 8, 4);
          if (t3 === 'minf') kids(moov, s3, e3, (t4, s4, e4) => {
            if (t4 === 'stbl') kids(moov, s4, e4, (t5, s5) => {
              if (t5 === 'stsd') {
                const entry = s5 + 8; const fourcc = ascii(moov, entry + 4, 4);
                st.codec = MP4_CODEC[fourcc] || fourcc.trim().toLowerCase();
                if (st.handler === 'soun') st.channels = u16(moov, entry + 24);
                if (st.handler === 'vide') { st.width = u16(moov, entry + 32) || st.width; st.height = u16(moov, entry + 34) || st.height; }
              }
            });
          });
        });
      });
      const type = { vide: 'Video', soun: 'Audio', sbtl: 'Subtitle', text: 'Subtitle', subt: 'Subtitle' }[st.handler];
      if (type) out.streams.push({ type, codec: st.codec, language: st.language === 'und' || st.language === '```' ? null : st.language,
        ...(type === 'Video' ? { width: st.width, height: st.height } : {}), ...(type === 'Audio' ? { channels: st.channels } : {}) });
    }
  });
  return out;
}

// ---------------- Matroska ----------------

const MKV_CODEC = { 'V_MPEG4/ISO/AVC': 'h264', 'V_MPEGH/ISO/HEVC': 'hevc', 'V_MPEG4/ISO/ASP': 'mpeg4', 'V_MPEG4/ISO/SP': 'mpeg4', 'V_MS/VFW/FOURCC': 'mpeg4', 'V_MPEG2': 'mpeg2video', 'V_VP8': 'vp8', 'V_VP9': 'vp9', 'V_AV1': 'av1',
  'A_AAC': 'aac', 'A_AC3': 'ac3', 'A_EAC3': 'eac3', 'A_DTS': 'dts', 'A_TRUEHD': 'truehd', 'A_FLAC': 'flac', 'A_OPUS': 'opus', 'A_VORBIS': 'vorbis', 'A_MPEG/L3': 'mp3', 'A_MPEG/L2': 'mp2', 'A_PCM/INT/LIT': 'pcm_s16le',
  'S_TEXT/UTF8': 'subrip', 'S_TEXT/ASS': 'ass', 'S_TEXT/SSA': 'ssa', 'S_HDMV/PGS': 'PGSSUB', 'S_VOBSUB': 'dvdsub', 'S_TEXT/WEBVTT': 'webvtt', 'S_DVBSUB': 'dvbsub' };

function vint(b, o, keepMarker) {
  const first = b[o]; if (first === undefined) return null;
  let len = 1, mask = 0x80;
  while (len <= 8 && !(first & mask)) { len++; mask >>= 1; }
  if (len > 8) return null;
  let value = keepMarker ? first : first & (mask - 1);
  let allOnes = (first & (mask - 1)) === mask - 1;
  for (let i = 1; i < len; i++) { value = value * 256 + b[o + i]; if (b[o + i] !== 0xff) allOnes = false; }
  return { value, len, unknown: !keepMarker && allOnes };
}

function* ebml(b, start, end) {
  let o = start;
  while (o < end) {
    const id = vint(b, o, true); if (!id) return;
    const sz = vint(b, o + id.len, false); if (!sz) return;
    const dataStart = o + id.len + sz.len;
    const size = sz.unknown ? end - dataStart : sz.value;
    yield { id: id.value, start: dataStart, size, end: Math.min(dataStart + size, end), truncated: dataStart + size > end };
    o = dataStart + size;
  }
}
const uint = (b, s, n) => { let v = 0; for (let i = 0; i < n; i++) v = v * 256 + b[s + i]; return v; };
const float = (b, s, n) => { const dv = new DataView(b.buffer, b.byteOffset + s, n); return n === 4 ? dv.getFloat32(0) : dv.getFloat64(0); };
const str = (b, s, n) => new TextDecoder().decode(b.subarray(s, s + n)).replace(/\0+$/, '');

async function probeMkv(reader, head) {
  const out = { container: 'mkv', streams: [] };
  let segStart = null, segEnd = head.length, buf = head;
  for (const el of ebml(head, 0, head.length)) {
    if (el.id === 0x1a45dfa3) for (const c of ebml(head, el.start, el.end)) if (c.id === 0x4282 && str(head, c.start, c.size) === 'webm') out.container = 'webm';
    if (el.id === 0x18538067) { segStart = el.start; segEnd = el.end; break; }
  }
  if (segStart == null) throw new Error('mkv: no segment');
  let info = null, tracks = null; const seeks = {};
  for (const el of ebml(buf, segStart, segEnd)) {
    if (el.id === 0x114d9b74) for (const s of ebml(buf, el.start, el.end)) if (s.id === 0x4dbb) {
      let sid = 0, pos = 0;
      for (const f of ebml(buf, s.start, s.end)) { if (f.id === 0x53ab) sid = uint(buf, f.start, f.size); if (f.id === 0x53ac) pos = uint(buf, f.start, f.size); }
      seeks[sid] = pos;
    }
    if (el.id === 0x1549a966 && !el.truncated) info = el;
    if (el.id === 0x1654ae6b && !el.truncated) tracks = el;
    if (el.id === 0x1f43b675) break; // first Cluster
  }
  const fetchEl = async (pos) => { const b = await reader(segStart + pos, 256 * 1024); const el = ebml(b, 0, b.length).next().value; return el ? { b, el } : null; };
  let ib = buf, tb = buf;
  if (!info && seeks[0x1549a966] != null) { const r = await fetchEl(seeks[0x1549a966]); if (r) { ib = r.b; info = r.el; } }
  if (!tracks && seeks[0x1654ae6b] != null) { const r = await fetchEl(seeks[0x1654ae6b]); if (r) { tb = r.b; tracks = r.el; } }
  if (info) {
    let scale = 1_000_000, dur = null;
    for (const f of ebml(ib, info.start, info.end)) { if (f.id === 0x2ad7b1) scale = uint(ib, f.start, f.size); if (f.id === 0x4489) dur = float(ib, f.start, f.size); }
    if (dur) out.durationTicks = Math.round((dur * scale) / 100);
  }
  if (tracks) for (const te of ebml(tb, tracks.start, tracks.end)) {
    if (te.id !== 0xae) continue;
    const t = { language: 'eng', isDefault: true, isForced: false };
    for (const f of ebml(tb, te.start, te.end)) {
      if (f.id === 0x83) t.kind = uint(tb, f.start, f.size);
      if (f.id === 0x86) t.codecId = str(tb, f.start, f.size);
      if (f.id === 0x22b59c) t.language = str(tb, f.start, f.size);
      if (f.id === 0x22b59d) t.bcp47 = str(tb, f.start, f.size);
      if (f.id === 0x536e) t.title = str(tb, f.start, f.size);
      if (f.id === 0x88) t.isDefault = uint(tb, f.start, f.size) === 1;
      if (f.id === 0x55aa) t.isForced = uint(tb, f.start, f.size) === 1;
      if (f.id === 0xe0) for (const v of ebml(tb, f.start, f.end)) { if (v.id === 0xb0) t.width = uint(tb, v.start, v.size); if (v.id === 0xba) t.height = uint(tb, v.start, v.size); }
      if (f.id === 0xe1) for (const a of ebml(tb, f.start, f.end)) { if (a.id === 0x9f) t.channels = uint(tb, a.start, a.size); if (a.id === 0xb5) t.sampleRate = Math.round(float(tb, a.start, a.size)); }
    }
    const type = { 1: 'Video', 2: 'Audio', 17: 'Subtitle' }[t.kind];
    if (!type) continue;
    const lang = t.language === 'und' ? null : (t.bcp47 || t.language);
    out.streams.push({ type, codec: MKV_CODEC[t.codecId] || (t.codecId || '').toLowerCase(), language: lang, title: t.title || null,
      isDefault: t.isDefault, isForced: t.isForced,
      ...(type === 'Video' ? { width: t.width, height: t.height } : {}),
      ...(type === 'Audio' ? { channels: t.channels, sampleRate: t.sampleRate } : {}) });
  }
  return out;
}

// ---------------- AVI ----------------

const AVI_VIDEO = { xvid: 'mpeg4', divx: 'mpeg4', dx50: 'mpeg4', div3: 'msmpeg4v3', fmp4: 'mpeg4', h264: 'h264', x264: 'h264', avc1: 'h264', mjpg: 'mjpeg' };
const AVI_AUDIO = { 0x55: 'mp3', 0x50: 'mp2', 0x2000: 'ac3', 0x2001: 'dts', 0xff: 'aac', 0x1: 'pcm_s16le', 0x161: 'wmav2' };

function probeAvi(b) {
  const out = { container: 'avi', streams: [] };
  let usec = 0, total = 0, odmlTotal = 0, vlen = 0, vscale = 0, vrate = 0;
  const walk = (s, e) => {
    for (let o = s; o + 8 <= e;) {
      const id = ascii(b, o, 4), size = le32(b, o + 4), d = o + 8;
      if (id === 'LIST') { const lt = ascii(b, d, 4); if (lt === 'movi') return; walk(d + 4, Math.min(d + size, e)); }
      else if (id === 'avih') { usec = le32(b, d); total = le32(b, d + 16); }
      else if (id === 'dmlh') odmlTotal = le32(b, d);
      else if (id === 'strh') {
        const fcc = ascii(b, d, 4), handler = ascii(b, d + 4, 4).toLowerCase();
        out._last = { fcc, handler };
        if (fcc === 'vids') { vscale = le32(b, d + 20); vrate = le32(b, d + 24); vlen = le32(b, d + 32); }
      } else if (id === 'strf' && out._last) {
        if (out._last.fcc === 'vids') { const comp = ascii(b, d + 16, 4).toLowerCase(); out.streams.push({ type: 'Video', codec: AVI_VIDEO[comp] || AVI_VIDEO[out._last.handler] || comp.trim(), width: le32(b, d + 4), height: le32(b, d + 8) }); }
        if (out._last.fcc === 'auds') out.streams.push({ type: 'Audio', codec: AVI_AUDIO[le16(b, d)] || `0x${le16(b, d).toString(16)}`, channels: le16(b, d + 2), sampleRate: le32(b, d + 4) });
        out._last = null;
      }
      o = d + size + (size & 1);
    }
  };
  walk(12, b.length);
  delete out._last;
  const frames = Math.max(odmlTotal, total, vlen);
  let secs = 0;
  if (vscale && vrate && vlen && vlen >= total) secs = (vlen * vscale) / vrate;
  else if (usec && frames) secs = (frames * usec) / 1e6;
  if (secs) out.durationTicks = Math.round(secs * TICKS);
  return out;
}
