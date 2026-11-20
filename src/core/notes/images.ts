// Image files: which files are images, and their MIME type. Apart from files.ts, which the fold of the Session Log uses.

// The image types a vision model takes, by file extension.
const IMAGE_TYPES: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' };

export const IMAGE_EXTENSIONS = Object.keys(IMAGE_TYPES);

// The MIME type of an image file (or its copy, or an @path reference `path[:a[-b]]` to it), null for any other file.
export const imageType = (path: string): string | null => {
  const extension = /\.([^.:]+)(?::\d+(?:-\d+)?)?$/.exec(path)?.[1];
  return extension === undefined ? null : IMAGE_TYPES[extension.toLowerCase()] ?? null;
};

// Whether an @path reference names an image file.
export const isImage = (file: string) => imageType(file) !== null;
