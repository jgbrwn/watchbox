import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseMovie, parseEpisode } from '../src/library/parse.mjs';
import { mapEpisode, similarity } from '../src/library/match.mjs';

const movie = (p, size = 2e9) => { const r = parseMovie(p, size); return [r.kind, r.title, r.year]; };
const ep = p => { const r = parseEpisode(p, 5e8); return [r.kind, r.series, r.season, r.episode, r.absolute]; };

test('movie names', () => {
  assert.deepEqual(movie('Two-Lane Blacktop (1971)/Two-Lane.Blacktop.1971.1080p.BluRay.H264.AAC-RARBG.mp4'), ['movie', 'Two-Lane Blacktop', 1971]);
  assert.deepEqual(movie('While.Were.Young.2014.1080p.BluRay.x265/While.Were.Young.2014.1080p.BluRay.x265.mp4'), ['movie', 'While Were Young', 2014]);
  assert.deepEqual(movie('Prime.Cut.1972.1080p.BluRay.H264.AAC-RARBG/Prime.Cut.1972.1080p.BluRay.H264.AAC-RARBG.mp4'), ['movie', 'Prime Cut', 1972]);
  assert.deepEqual(movie('Nixon Directors Cut (1995)/Nixon.1995.DC.1080p.BluRay.x265-RARBG.mp4'), ['movie', 'Nixon', 1995]);
  assert.deepEqual(movie('10 (1979)/10.1979.1080p.BluRay.x265.mp4'), ['movie', '10', 1979]);
  assert.deepEqual(movie('Pirates.of.Silicon.Valley.1999-[WideScreen]-DVDRip.H.264.AC3.MKV.HQ-Raven/x.mkv'), ['movie', 'Pirates of Silicon Valley', 1999]);
  assert.deepEqual(movie('Docu Pack/1985 - Shoah - AVI/Shoah 3.avi'), ['movie', 'Shoah', 1985]);
  assert.deepEqual(movie('Docu Pack/2006 - Inside North Korea - WMV/National Geographic   Inside North Korea.wmv'), ['movie', 'Inside North Korea', 2006]);
  assert.equal(parseMovie('S.O.B.1981.1080p.BluRay.x264/S.O.B.1981.1080p.BluRay.x264.mkv', 2e9).title, 'S.O.B.');
  assert.equal(parseMovie('Anne.of.Green.Gables.1985.Part1.1080p.BluRay.x264-SADPANDA/a.part1.mkv', 2e9).part, 1);
});

test('samples and extras are hidden', () => {
  assert.equal(movie('True Romance (1993)/Sample/true.romance.1993.2160p.sample.mkv', 5e7)[0], 'sample');
  assert.equal(movie('The.Bronze.2015.1080p.BluRay.DTS.x264-ETRG/The.Bronze.2015.1080p.BluRay.DTS.x264-ETRG.Sample.mkv', 5e7)[0], 'sample');
  assert.equal(movie('Violent Cop (1989)/Featurettes/Trailers/Original Trailer.mkv')[0], 'extra');
  assert.equal(ep('The Company/Season 01/Featurettes/VFX.mkv')[0], 'extra');
  assert.equal(ep('Graveyard.S02E03.1080p.WEB.h264-EDITH/Sample/graveyard.s02e03.sample.mkv')[0], 'sample');
});

test('episode coordinates', () => {
  assert.deepEqual(ep('Wonder Woman/Season 03/wws3e15.mkv'), ['episode', 'Wonder Woman', 3, 15, null]);
  assert.deepEqual(ep('nypd blue/102-Weaver Of Hate.ia.mp4'), ['episode', 'nypd blue', null, null, 102]);
  assert.deepEqual(ep("Smiley's People/Season 01/Smiley's People - S01 - E01.avi"), ['episode', "Smiley's People", 1, 1, null]);
  assert.deepEqual(ep('Gåsmamman.S04.SweSub.1080p.x264-Justiso/Gåsmamman.S04E03.mkv'), ['episode', 'Gåsmamman', 4, 3, null]);
  assert.deepEqual(ep('The Avengers/Season 03/3x03 - Man With Two Shadows.avi'), ['episode', 'The Avengers', 3, 3, null]);
  assert.deepEqual(ep('Tinker, Tailor, Soldier, Spy/Season 01/Tinker,Tailor,Soldier,Spy 3 - Smiley Tracks The Mole.mkv'), ['episode', 'Tinker, Tailor, Soldier, Spy', 1, 3, null]);
  assert.deepEqual(ep('Homicide.Life.On.The.Street.S07E13.1080p.WEB.H264-SKYFiRE/x.S07E13.mkv'), ['episode', 'Homicide Life On The Street', 7, 13, null]);
  assert.equal(parseEpisode('Strike Back/Season 01/Strike.Back.S01E01-E02.1080p.BluRay.x264-TENEIGHTY.mkv', 1e9).episodeEnd, 2);
  assert.equal(parseEpisode('Kin/Kin.2021.S02E01.Episode.1.1080p.mkv', 1e9).seriesYear, 2021);
});

test('episode mapping', () => {
  const eps = [{ season: 1, episode: 1, name: 'Pilot' }, { season: 1, episode: 2, name: 'Weaver of Hate' }, { season: 2, episode: 1, name: 'Up on the Roof' }];
  assert.deepEqual(mapEpisode({ absolute: 2, epTitle: 'Weaver Of Hate ia' }, eps), { season: 1, episode: 2, how: 'absolute' });
  assert.deepEqual(mapEpisode({ season: 2, episode: 1 }, eps), { season: 2, episode: 1, how: 'number' });
  assert.equal(mapEpisode({ season: 5, episode: 9, epTitle: 'Up on the Roof' }, eps).how, 'title');
  assert.ok(similarity('Micki + Maude', 'Micki & Maude') > 0.7);
});
