import { expect, test } from 'bun:test';
import { imageType, isImage } from './images';

test('images by extension, any case; a reference with a line range still names its file', () => {
  expect([imageType('a.png'), imageType('b.JPG'), imageType('c.webp'), imageType('d.ts'), imageType('png')]).toEqual(['image/png', 'image/jpeg', 'image/webp', null, null]);
  expect([isImage('shot.png'), isImage('shot.png:2-3'), isImage('notes.txt:2')]).toEqual([true, true, false]);
});
