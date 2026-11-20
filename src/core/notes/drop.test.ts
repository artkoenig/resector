import { expect, test } from 'bun:test';
import { droppedImages, droppedPaths } from './drop';

test('a dropped path as terminals paste it: plain, shell-escaped, quoted or a file URL', () => {
  expect(droppedPaths('/a/shot.png')).toEqual(['/a/shot.png']);
  expect(droppedPaths('/a/Screen\\ Shot\\ \\(1\\).png ')).toEqual(['/a/Screen Shot (1).png']);
  expect(droppedPaths("'/a/Screen Shot.png'")).toEqual(['/a/Screen Shot.png']);
  expect(droppedPaths('"/a/Screen Shot.png"')).toEqual(['/a/Screen Shot.png']);
  expect(droppedPaths("'/a/it'\\''s.png'")).toEqual(["/a/it's.png"]);
  expect(droppedPaths('file:///a/Screen%20Shot.png')).toEqual(['/a/Screen Shot.png']);
  expect(droppedPaths('file://localhost/a/b.png')).toEqual(['/a/b.png']);
});

test('several dropped files, separated by spaces or lines', () => {
  expect(droppedPaths('/a/x.png /b/Y\\ z.jpg')).toEqual(['/a/x.png', '/b/Y z.jpg']);
  expect(droppedPaths('/a/x.png\n/b/y.jpg\n')).toEqual(['/a/x.png', '/b/y.jpg']);
});

test('no dropped paths: relative words, an open quote, empty text', () => {
  expect(droppedPaths('see shot.png')).toBeNull();
  expect(droppedPaths('shot.png')).toBeNull();
  expect(droppedPaths("'/a/shot.png")).toBeNull();
  expect(droppedPaths('  ')).toBeNull();
  expect(droppedPaths('file://host/a.png')).toBeNull();
});

const exists = (files: string[]) => (path: string) => files.includes(path);

test('dropped images become @path references: relative inside the Project, absolute outside, quoted with spaces', () => {
  const found = exists(['shot.png', 'docs/My Shot.jpg', '/Users/me/Desktop/a.webp']);
  expect(droppedImages('/project/shot.png', '/project', found)).toBe('@shot.png');
  expect(droppedImages('/project/docs/My\\ Shot.jpg /Users/me/Desktop/a.webp', '/project', found)).toBe('@"docs/My Shot.jpg" @/Users/me/Desktop/a.webp');
});

test('a paste stays as it is unless every path is an existing image', () => {
  const found = exists(['shot.png', 'notes.md']);
  expect(droppedImages('/project/notes.md', '/project', found)).toBeNull();
  expect(droppedImages('/project/shot.png /project/gone.png', '/project', found)).toBeNull();
  expect(droppedImages('/project/shot.png /project/notes.md', '/project', found)).toBeNull();
  expect(droppedImages('hello world', '/project', found)).toBeNull();
  // A path the reference syntax cannot write.
  expect(droppedImages('\'/a/"b".png\'', '/project', () => true)).toBeNull();
});

test('the Project root itself is no prefix of a sibling directory', () => {
  expect(droppedImages('/project-b/shot.png', '/project', exists(['/project-b/shot.png']))).toBe('@/project-b/shot.png');
});
