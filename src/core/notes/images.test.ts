import { expect, test } from 'bun:test';
import { imageType, isImage } from './images';

test('images by extension, any case; a reference with a line range still names its file', () => {
  expect([imageType('a.png'), imageType('b.JPG'), imageType('c.webp'), imageType('d.ts'), imageType('png')]).toEqual(['image/png', 'image/jpeg', 'image/webp', null, null]);
  expect([imageType('e.jpeg'), imageType('f.gif'), imageType('.png'), imageType('g.png.txt'), imageType('h.png:x')]).toEqual(['image/jpeg', 'image/gif', 'image/png', null, null]);
  expect([isImage('shot.png'), isImage('shot.png:2-3'), isImage('shot.png:12-34'), isImage('notes.txt:2')]).toEqual([true, true, true, false]);
});
