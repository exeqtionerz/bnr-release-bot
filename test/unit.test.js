import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseReleaseName, classify, plan } from '../src/releases.js';
import { templateCaptions, applyEdit, mainText } from '../src/captions.js';
import { chunking } from '../src/platforms/tiktok.js';
import { clipStart } from '../src/media.js';
import { headerJson } from '../src/dropbox.js';

test('parse release folder names', () => {
  assert.deepEqual(
    (({ catalog, artist, title }) => ({ catalog, artist, title }))(parseReleaseName('BNR 070 - Exeqtionerz & Brain Damage - Voices In The Chaos')),
    { catalog: 'BNR 070', artist: 'Exeqtionerz & Brain Damage', title: 'Voices In The Chaos' },
  );
  const n = parseReleaseName('BNR 072 - DJ NANDO - GABBER FOR GLORY (MASTERS)');
  assert.equal(n.artist, 'DJ Nando');
  assert.equal(n.title, 'Gabber For Glory');
  const r = parseReleaseName('BNR 062 Releaser - The Feeling');
  assert.equal(r.catalog, 'BNR 062');
  assert.equal(r.artist, 'Releaser');
  assert.equal(r.title, 'The Feeling');
  assert.equal(parseReleaseName('BNR 053 - Releaser - Cyberpunk').title, 'Cyberpunk');
  assert.equal(parseReleaseName('Random folder').title, 'Random folder');
});

// Real layout of "BNR 062 Releaser - The Feeling" in Dropbox.
const FEELING = [
  ['Cover/Release - the feeling.png', 12667987], ['Cover/AUDIO/The Feeling - Video.wav', 10754468],
  ['Cover/AUDIO/12y21r - The Feeling - Releaser (MASTERING).wav', 31899612], ['Cover/Release - the feeling Stories.png', 3709363],
  ['Cover/Release - the feeling 4-3 ratio.png', 2868373], ['Animations/STORIES1.mp4', 29949801], ['Animations/releaser youtube.mp4', 329148256],
  ['Animations/releaser stories audio deliverd.mp4', 111423757], ['Animations/WIDE 2.mp4', 30096153], ['Animations/Sptofiy canvas.mp4', 16918363],
  ['Animations/Stories 2.mp4', 29949817], ['Animations/WIDE1.mp4', 17104203], ['Animations/WIDE 3 audio deliverd.mp4', 111486137],
  ['12y21r - The Feeling - Releaser (MASTERING).wav', 31899612], ['The Feeling - RELEASER (Extended Mix).wav', 35191040],
  ['The Feeling - Video.wav', 10754468], ['videos/HDversion.mp4', 72926388], ['videos/Stories.mp4', 73026712],
  ['videos/releaser send.mp4', 288908462], ['Release - the feeling.png', 12667987],
].map(([rel, size]) => {
  const path = `/R/${rel}`;
  const f = { name: rel.split('/').pop(), path, rel, size, depth: rel.split('/').length - 1 };
  return { ...f, role: classify(f) };
});

test('classify files', () => {
  const role = (n) => FEELING.find((f) => f.rel === n).role;
  assert.equal(role('The Feeling - RELEASER (Extended Mix).wav'), 'audio_extended');
  assert.equal(role('The Feeling - Video.wav'), 'audio_short');
  assert.equal(role('12y21r - The Feeling - Releaser (MASTERING).wav'), 'audio_master');
  assert.equal(role('Release - the feeling.png'), 'image_square');
  assert.equal(role('Cover/Release - the feeling Stories.png'), 'image_vertical');
  assert.equal(role('Cover/Release - the feeling 4-3 ratio.png'), 'image_wide');
  assert.equal(role('Animations/Sptofiy canvas.mp4'), 'video_canvas');
  assert.equal(role('videos/Stories.mp4'), 'video_vertical');
  assert.equal(role('Animations/releaser youtube.mp4'), 'video_wide');
  assert.equal(role('videos/HDversion.mp4'), 'video_wide');
});

test('default plan picks sensible files', () => {
  const p = plan(FEELING);
  assert.equal(p.youtube.video, '/R/Animations/releaser youtube.mp4');
  assert.equal(p.soundcloud.audio, '/R/The Feeling - RELEASER (Extended Mix).wav');
  assert.equal(p.soundcloud.image, '/R/Release - the feeling.png');
  assert.equal(p.instagram.image, '/R/Cover/Release - the feeling Stories.png');
  assert.equal(p.instagram.audio, '/R/The Feeling - Video.wav');
  assert.match(p.instagram.video, /stories/i);
  assert.deepEqual(p.instagram, p.tiktok);
});

test('plan on a folder with only a wav (Antenora single)', () => {
  const f = { name: 'Antenora - Turn Up (Extended Mix) [MASTER 16bit].wav', path: '/A/x.wav', rel: 'x.wav', size: 46e6, depth: 0 };
  const p = plan([{ ...f, role: classify(f) }]);
  assert.equal(p.soundcloud.audio, '/A/x.wav');
  assert.equal(p.youtube.video, null);
  assert.equal(p.youtube.image, null);
});

test('captions', () => {
  const c = templateCaptions({ catalog: 'BNR 070', artist: 'Exeqtionerz & Brain Damage', title: 'Voices In The Chaos' });
  assert.equal(c.youtube.title, 'Exeqtionerz & Brain Damage - Voices In The Chaos [BNR 070]');
  assert.match(c.instagram.caption, /#exeqtionerz #braindamage/);
  assert.ok(!/extreme/i.test(JSON.stringify(c)));
  applyEdit('youtube', c, 'New title\n---\nNew description');
  assert.equal(c.youtube.title, 'New title');
  assert.equal(c.youtube.description, 'New description');
  assert.equal(mainText('youtube', c), 'New title\n---\nNew description');
  applyEdit('tiktok', c, '  hey  ');
  assert.equal(c.tiktok.caption, 'hey');
});

test('tiktok chunking rules', () => {
  const MB = 1024 * 1024;
  assert.deepEqual(chunking(30 * MB), { chunk: 30 * MB, count: 1 });
  const c = chunking(111 * MB);
  assert.equal(c.chunk, 10 * MB);
  assert.equal(c.count, 11);
  const last = 111 * MB - (c.count - 1) * c.chunk;
  assert.ok(last >= 5 * MB && last <= 128 * MB);
});

test('clip start lands after the intro', () => {
  assert.equal(clipStart(40, 60), 0);
  assert.equal(clipStart(300, 60), 90);
  assert.ok(clipStart(70, 60) <= 8);
});

test('dropbox header escapes non-ascii', () => {
  assert.equal(headerJson({ path: '/Móvil' }), '{"path":"/M\\u00f3vil"}');
});
