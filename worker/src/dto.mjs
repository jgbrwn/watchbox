// BaseItemDto / MediaSource / UserData builders.
import { hashId } from './library/sync.mjs';

const parse = s => { try { return s ? JSON.parse(s) : null; } catch { return null; } };
export const imageTag = path => !path ? null : path.startsWith('origin:') ? 'o' + fnv(path) : path.replace(/[^A-Za-z0-9]/g, '').slice(0, 32);
// Files on the storage host share long path prefixes, so their tags are a hash of the whole path.
function fnv(s) { let a = 0x811c9dc5, b = 0; for (const c of new TextEncoder().encode(s)) { a = Math.imul(a ^ c, 0x01000193) >>> 0; b = Math.imul(b ^ c, 0x5bd1e995) + 1 >>> 0; } return a.toString(16).padStart(8, '0') + b.toString(16).padStart(8, '0'); }
const iso = t => t ? new Date(t * 1000).toISOString() : undefined;
const dateIso = d => d ? `${d}T00:00:00.0000000Z` : undefined;

const LANG = { eng: 'English', en: 'English', swe: 'Swedish', sv: 'Swedish', ger: 'German', deu: 'German', de: 'German', fre: 'French', fra: 'French', fr: 'French', spa: 'Spanish', es: 'Spanish', ita: 'Italian', it: 'Italian', dan: 'Danish', da: 'Danish', nor: 'Norwegian', no: 'Norwegian', nob: 'Norwegian', fin: 'Finnish', fi: 'Finnish', dut: 'Dutch', nld: 'Dutch', nl: 'Dutch', por: 'Portuguese', pt: 'Portuguese', jpn: 'Japanese', ja: 'Japanese', kor: 'Korean', ko: 'Korean', chi: 'Chinese', zho: 'Chinese', zh: 'Chinese', rus: 'Russian', ru: 'Russian', pol: 'Polish', pl: 'Polish', ara: 'Arabic', heb: 'Hebrew', hin: 'Hindi', tur: 'Turkish', gre: 'Greek', ell: 'Greek', cze: 'Czech', ces: 'Czech', hun: 'Hungarian', ice: 'Icelandic', isl: 'Icelandic' };
const langName = l => (l && LANG[l.toLowerCase().split('-')[0]]) || (l ? l.toUpperCase() : 'Unknown');
const layout = c => ({ 1: 'mono', 2: 'stereo', 6: '5.1', 8: '7.1' }[c] || (c ? `${c} ch` : ''));
const resLabel = (w, h) => !w ? '' : w >= 3200 || h >= 1800 ? '4K' : w >= 1800 || h >= 1000 ? '1080p' : w >= 1200 || h >= 700 ? '720p' : h >= 540 ? '576p' : '480p';

export function mediaStreams(row, ctx) {
  const embedded = parse(row.streams) || [];
  const out = [];
  let firstAudio = -1, defaultSub = -1;
  embedded.forEach((s, i) => {
    const base = { Index: i, Type: s.type, Codec: s.codec || undefined, Language: s.language || undefined, IsDefault: s.isDefault ?? i === 0, IsForced: !!s.isForced, IsHearingImpaired: false, IsExternal: false, IsInterlaced: false, IsTextSubtitleStream: false, SupportsExternalStream: false, Title: s.title || undefined, VideoRange: 'Unknown', VideoRangeType: 'Unknown', AudioSpatialFormat: 'None', IsAnamorphic: false };
    if (s.type === 'Video') {
      out.push({ ...base, Width: s.width, Height: s.height, AspectRatio: s.width && s.height ? (s.width / s.height).toFixed(2) : undefined, VideoRange: 'SDR', VideoRangeType: 'SDR', DisplayTitle: [resLabel(s.width, s.height), (s.codec || '').toUpperCase()].filter(Boolean).join(' '), RealFrameRate: undefined });
    } else if (s.type === 'Audio') {
      if (firstAudio < 0) firstAudio = i;
      out.push({ ...base, Channels: s.channels, ChannelLayout: layout(s.channels), SampleRate: s.sampleRate, DisplayTitle: [langName(s.language), (s.codec || '').toUpperCase(), layout(s.channels)].filter(Boolean).join(' - ') + (s.isDefault ? ' - Default' : '') });
    } else if (s.type === 'Subtitle') {
      const text = ['subrip', 'ass', 'ssa', 'webvtt', 'mov_text'].includes(s.codec);
      out.push({ ...base, IsTextSubtitleStream: text, SupportsExternalStream: text, DisplayTitle: [langName(s.language), s.title, (s.codec || '').toUpperCase(), s.isForced ? 'Forced' : ''].filter(Boolean).join(' - ') });
    }
  });
  for (const [j, sub] of (parse(row.subtitles) || []).entries()) {
    const index = embedded.length + j;
    const codec = sub.format === 'srt' ? 'srt' : sub.format;
    const url = `/Videos/${row.id}/${row.id}/Subtitles/${index}/0/Stream.${sub.format}?api_key=${ctx.token || ''}`;
    if (sub.forced && defaultSub < 0) defaultSub = index;
    out.push({ Index: index, Type: 'Subtitle', Codec: codec, Language: sub.language || undefined, IsExternal: true, IsDefault: false, IsForced: !!sub.forced, IsHearingImpaired: false, IsInterlaced: false, VideoRange: 'Unknown', VideoRangeType: 'Unknown', AudioSpatialFormat: 'None',
      IsTextSubtitleStream: true, SupportsExternalStream: true, DeliveryMethod: 'External', DeliveryUrl: url, IsExternalUrl: false, Path: sub.path.split('/').at(-1),
      DisplayTitle: [langName(sub.language), sub.forced ? 'Forced' : '', codec.toUpperCase(), 'External'].filter(Boolean).join(' - ') });
  }
  return { streams: out, defaultAudio: firstAudio, defaultSub };
}

export function mediaSource(row, ctx) {
  const { streams, defaultAudio, defaultSub } = mediaStreams(row, ctx);
  const ext = row.container || 'mkv';
  const query = `static=true&mediaSourceId=${row.id}&api_key=${ctx.token || ''}`;
  const rel = `/Videos/${row.id}/stream.${ext}?${query}`;
  const bitrate = row.size && row.runtime_ticks ? Math.round(row.size * 8 / (row.runtime_ticks / 1e7)) : undefined;
  return {
    Protocol: 'Http', Id: row.id, Path: ctx.origin + rel, Type: 'Default', Container: ext, Size: row.size,
    Name: row.name, IsRemote: false, ETag: row.hash, RunTimeTicks: row.runtime_ticks || undefined,
    ReadAtNativeFramerate: false, IgnoreDts: false, IgnoreIndex: false, GenPtsInput: false,
    SupportsTranscoding: false, SupportsDirectStream: true, SupportsDirectPlay: true, IsInfiniteStream: false, UseMostCompatibleTranscodingProfile: false,
    RequiresOpening: false, RequiresClosing: false, RequiresLooping: false, SupportsProbing: true, VideoType: 'VideoFile',
    MediaStreams: streams, MediaAttachments: [], Formats: [], Bitrate: bitrate, RequiredHttpHeaders: {},
    DirectStreamUrl: rel, TranscodingSubProtocol: 'http', HasSegments: false,
    ...(defaultAudio >= 0 ? { DefaultAudioStreamIndex: defaultAudio } : {}),
    DefaultSubtitleStreamIndex: defaultSub
  };
}

// Primary file plus any alternate versions (each streams by its own file id).
export function mediaSources(row, ctx) {
  const main = mediaSource(row, ctx);
  const alts = parse(row.versions) || [];
  if (!alts.length) return [main];
  main.Name = labelFor(row);
  return [main, ...alts.map(v => ({ ...mediaSource({ ...row, id: v.id, container: v.container, size: v.size, runtime_ticks: v.runtime_ticks || row.runtime_ticks, streams: JSON.stringify(v.streams), subtitles: '[]', hash: v.id }, ctx), Name: v.label }))];
}
const labelFor = row => { const v = (parse(row.streams) || []).find(s => s.type === 'Video'); return [resLabel(v?.width, v?.height), row.container?.toUpperCase()].filter(Boolean).join(' ') || row.name; };

export function userData(row, u = {}) {
  const pos = u.position_ticks || 0;
  const played = !!u.played;
  const d = { PlaybackPositionTicks: pos, PlayCount: u.play_count || 0, IsFavorite: !!u.favorite, Played: played, Key: row.id, ItemId: row.id };
  if (u.last_played) d.LastPlayedDate = iso(u.last_played);
  if (pos > 0 && row.runtime_ticks) d.PlayedPercentage = Math.min(100, (pos / row.runtime_ticks) * 100);
  if (u.unplayed != null) { d.UnplayedItemCount = u.unplayed; if (u.total) d.PlayedPercentage = ((u.total - u.unplayed) / u.total) * 100; d.Played = u.unplayed === 0 && u.total > 0; }
  return d;
}

const PORTRAIT = 2 / 3, LANDSCAPE = 16 / 9;

/**
 * Build a BaseItemDto.
 * ctx: { serverId, origin, token, fields:Set|null (null = all), parents: Map(id -> row) for series/season image fallbacks }
 */
export async function itemDto(row, ctx, u = {}) {
  const all = !ctx.fields;
  const want = f => all || ctx.fields.has(f.toLowerCase());
  const images = parse(row.images) || {};
  const tags = {};
  for (const t of ['Primary', 'Logo', 'Thumb']) if (images[t]) tags[t] = imageTag(images[t]);
  const isFile = row.type === 'Movie' || row.type === 'Episode';
  const genres = parse(row.genres) || [];
  const dto = {
    Name: row.name, ServerId: ctx.serverId, Id: row.id, Etag: row.hash,
    DateCreated: iso(row.date_created), CanDelete: false, CanDownload: isFile,
    SortName: row.sort_name, PremiereDate: dateIso(row.premiere_date),
    OfficialRating: row.official_rating || undefined, CommunityRating: row.rating ? Math.round(row.rating * 10) / 10 : undefined,
    RunTimeTicks: row.runtime_ticks || undefined, ProductionYear: row.year || undefined,
    IndexNumber: row.index_number ?? undefined, IndexNumberEnd: row.index_end ?? undefined, ParentIndexNumber: row.parent_index ?? undefined,
    IsFolder: !isFile, Type: row.type, ParentId: row.parent_id, LocationType: 'FileSystem',
    MediaType: isFile ? 'Video' : 'Unknown',
    ImageTags: tags, BackdropImageTags: images.Backdrop ? [imageTag(images.Backdrop)] : [],
    ImageBlurHashes: {},
    PrimaryImageAspectRatio: images.Primary ? (row.type === 'Episode' ? LANDSCAPE : PORTRAIT) : undefined,
    UserData: userData(row, u), LocalTrailerCount: 0, SpecialFeatureCount: 0, ChildCount: row.child_count ?? undefined,
    PlayAccess: 'Full', EnableMediaSourceDisplay: true, LockData: false, LockedFields: [], Tags: [], RemoteTrailers: [], ExternalUrls: [],
    DisplayPreferencesId: row.id
  };
  if (row.original_title && row.original_title !== row.name) dto.OriginalTitle = row.original_title;
  if (row.type === 'Series') { dto.Status = row.status || undefined; dto.EndDate = dateIso(row.end_date); dto.AirDays = []; dto.RecursiveItemCount = row.recursive_count; }
  if (row.type === 'Season' || row.type === 'Episode') {
    dto.SeriesName = row.series_name; dto.SeriesId = row.series_id;
    const series = ctx.parents?.get(row.series_id);
    const sImg = parse(series?.images) || {};
    if (sImg.Primary) dto.SeriesPrimaryImageTag = imageTag(sImg.Primary);
    if (sImg.Backdrop) { dto.ParentBackdropItemId = row.series_id; dto.ParentBackdropImageTags = [imageTag(sImg.Backdrop)]; }
    if (sImg.Logo) { dto.ParentLogoItemId = row.series_id; dto.ParentLogoImageTag = imageTag(sImg.Logo); }
    if (sImg.Thumb) { dto.ParentThumbItemId = row.series_id; dto.ParentThumbImageTag = imageTag(sImg.Thumb); }
    if (row.type === 'Season' && !images.Primary && sImg.Primary) { dto.ParentPrimaryImageItemId = row.series_id; dto.ParentPrimaryImageTag = imageTag(sImg.Primary); }
  }
  if (row.type === 'Episode') {
    dto.SeasonId = row.season_id; dto.SeasonName = row.season_name;
    const season = ctx.parents?.get(row.season_id);
    const seasonImg = parse(season?.images) || {};
    if (!images.Primary) { // no still: let clients fall back to series art
      const sImg = parse(ctx.parents?.get(row.series_id)?.images) || {};
      if (sImg.Backdrop) { dto.ParentThumbItemId = row.series_id; dto.ParentThumbImageTag = imageTag(sImg.Backdrop); }
    }
    if (seasonImg.Primary) dto.SeasonPrimaryImageTag = imageTag(seasonImg.Primary);
  }
  if (isFile) {
    dto.Container = row.container; dto.VideoType = 'VideoFile'; dto.HasSubtitles = !!(parse(row.subtitles)?.length || (parse(row.streams) || []).some(s => s.type === 'Subtitle'));
    const v = (parse(row.streams) || []).find(s => s.type === 'Video');
    if (v) { dto.Width = v.width; dto.Height = v.height; }
    dto.Path = row.name + '.' + row.container;
    if (want('MediaSources') || want('MediaStreams')) {
      const all = mediaSources(row, ctx);
      dto.MediaSources = all; dto.MediaStreams = all[0].MediaStreams;
    }
    const alts = parse(row.versions) || [];
    if (alts.length) dto.MediaSourceCount = alts.length + 1;
    dto.Chapters = [];
  }
  if (want('Overview')) dto.Overview = row.overview || undefined;
  if (row.tagline) dto.Taglines = [row.tagline]; else dto.Taglines = [];
  dto.Genres = genres;
  dto.GenreItems = await Promise.all(genres.map(async g => ({ Name: g, Id: await hashId('genre:' + g) })));
  dto.Studios = await Promise.all((parse(row.studios) || []).map(async s => ({ Name: s, Id: await hashId('studio:' + s) })));
  dto.ProviderIds = parse(row.provider_ids) || {};
  if (want('People')) dto.People = (parse(row.people) || []).map(p => ({ Name: p.name, Id: p.id, Role: p.role || undefined, Type: p.type, ...(p.image ? { PrimaryImageTag: imageTag(p.image) } : {}) }));
  else dto.People = [];
  return dto;
}

export async function viewDto(library, ctx, { id, rootId, count, image }) {
  return {
    Name: { movies: 'Movies', tv: 'TV Shows', youtube: 'YouTube' }[library], ServerId: ctx.serverId, Id: id, Etag: id,
    DateCreated: '2026-10-16T00:00:00.0000000Z', CanDelete: false, CanDownload: false,
    SortName: library, Path: '/' + library, IsFolder: true, ParentId: rootId, Type: 'CollectionFolder',
    CollectionType: library === 'tv' ? 'tvshows' : 'movies',   // YouTube videos are presented as movies (every app handles those) LocationType: 'FileSystem', MediaType: 'Unknown',
    ChildCount: count, DisplayPreferencesId: id, PlayAccess: 'Full', EnableMediaSourceDisplay: true,
    ImageTags: image ? { Primary: imageTag(image) } : {}, BackdropImageTags: [], ImageBlurHashes: {},
    PrimaryImageAspectRatio: image ? LANDSCAPE : undefined,
    UserData: { PlaybackPositionTicks: 0, PlayCount: 0, IsFavorite: false, Played: false, Key: id, ItemId: id },
    Genres: [], GenreItems: [], Studios: [], People: [], Taglines: [], Tags: [], ProviderIds: {}, RemoteTrailers: [], ExternalUrls: [], LockedFields: [], LockData: false
  };
}
