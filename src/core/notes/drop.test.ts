import { expect, test } from 'bun:test';
import { droppedFiles, droppedPaths } from './drop';

test('a dropped path as terminals paste it: plain, shell-escaped, quoted or a file URL', () => {
  expect(droppedPaths('/a/shot.png')).toEqual(['/a/shot.png']);
  expect(droppedPaths('/a/Screen\\ Shot\\ \\(1\\).png ')).toEqual(['/a/Screen Shot (1).png']);
  expect(droppedPaths("'/a/Screen Shot.png'")).toEqual(['/a/Screen Shot.png']);
  expect(droppedPaths('"/a/Screen Shot.png"')).toEqual(['/a/Screen Shot.png']);
  expect(droppedPaths("'/a/it'\\''s.png'")).toEqual(["/a/it's.png"]);
  expect(droppedPaths('file:///a/Screen%20Shot.png')).toEqual(['/a/Screen Shot.png']);
  expect(droppedPaths('file://localhost/a/b.png')).toEqual(['/a/b.png']);
  expect(droppedPaths('file:///a/localhost/b.png')).toEqual(['/a/localhost/b.png']);
  // Inside "…" only \", \\, \$ and \` are escapes.
  expect(droppedPaths('"/a/say \\"hi\\" \\$x \\y.png"')).toEqual(['/a/say "hi" $x \\y.png']);
  expect(droppedPaths('"/a/b\\ c.png"')).toEqual(['/a/b\\ c.png']);
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
  expect(droppedPaths('file:///a/%zz.png')).toBeNull();
  expect(droppedPaths('/a/x.png y.png')).toBeNull();
});

const usable = (files: string[]) => (path: string) => files.includes(path);

test('dropped files become @path references: relative inside the Project, absolute outside, quoted with spaces', () => {
  const found = usable(['shot.png', 'docs/My Shot.jpg', '/Users/me/Desktop/a.webp', 'notes.md', 'Makefile']);
  expect(droppedFiles('/project/shot.png', '/project', found)).toBe('@shot.png');
  expect(droppedFiles('/project/docs/My\\ Shot.jpg /Users/me/Desktop/a.webp', '/project', found)).toBe('@"docs/My Shot.jpg" @/Users/me/Desktop/a.webp');
  expect(droppedFiles('/project/notes.md /project/shot.png /project/Makefile', '/project', found)).toBe('@notes.md @shot.png @Makefile');
});

test('a paste stays as it is unless every path is a usable file', () => {
  const found = usable(['shot.png']);
  expect(droppedFiles('/project/data.bin', '/project', found)).toBeNull();
  expect(droppedFiles('/project/shot.png /project/gone.png', '/project', found)).toBeNull();
  expect(droppedFiles('hello world', '/project', found)).toBeNull();
  // A path the reference syntax cannot write.
  expect(droppedFiles('\'/a/"b".png\'', '/project', () => true)).toBeNull();
  expect(droppedFiles('/a/shot.png:12-34', '/project', () => true)).toBeNull();
  expect(droppedFiles('/a/shot.png:1', '/project', () => true)).toBeNull();
});

test('the Project root itself is no prefix of a sibling directory', () => {
  expect(droppedFiles('/project-b/shot.png', '/project', usable(['/project-b/shot.png']))).toBe('@/project-b/shot.png');
});
