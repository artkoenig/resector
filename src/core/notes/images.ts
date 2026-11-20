// Image files: which files are images, and their MIME type. Apart from files.ts, which the fold of the Session Log uses.

// The image types a vision model takes, by file extension.
const IMAGE_TYPES: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' };

// The MIME type of an image file (or its copy), null for any other file.
export const imageType = (path: string): string | null => {
  const dot = path.lastIndexOf('.');
  return dot < 0 ? null : IMAGE_TYPES[path.slice(dot + 1).toLowerCase()] ?? null;
};

// Whether an @path reference (`path[:a[-b]]`) names an image file.
export const isImage = (file: string) => imageType(file.replace(/:\d+(?:-\d+)?$/, '')) !== null;
