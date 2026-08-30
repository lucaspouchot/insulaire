/**
 * Path and type rules the content server enforces on every request.
 *
 * Kept apart from the server so they can be tested directly (`node --test`):
 * these few functions are the entire security boundary of an HTTP server that
 * writes files, and "it seemed to work in the browser" is not evidence.
 *
 * The rules are deliberately narrow. The server is an authoring tool bound to
 * the loopback interface, and it may only ever touch content-shaped files
 * inside one declared directory
 * (`docs/adr/ADR-0019-authoring-content-workspace.md`).
 */
import { isAbsolute, resolve, sep } from 'node:path';

/**
 * Extensions the server will read or write, by MIME type.
 *
 * A file the runtime cannot consume has no business in a content directory, and
 * an extension that is not here cannot be uploaded — that is what keeps the
 * editor's upload from becoming a general-purpose file drop.
 */
export const CONTENT_TYPES = Object.freeze({
  '.json': 'application/json; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ogg': 'audio/ogg',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.m4a': 'audio/mp4',
});

/** Largest body the server accepts, in bytes. Music is the reason it is 32 MB. */
export const MAX_UPLOAD_BYTES = 32 * 1024 * 1024;

/** The extension of `path`, lowercased, including the dot. `''` when there is none. */
export function extensionOf(path) {
  const lastSlash = path.lastIndexOf('/');
  const name = lastSlash === -1 ? path : path.slice(lastSlash + 1);
  const dot = name.lastIndexOf('.');
  return dot <= 0 ? '' : name.slice(dot).toLowerCase();
}

/** MIME type for `path`, or `null` when the extension is not allowed. */
export function contentTypeOf(path) {
  return CONTENT_TYPES[extensionOf(path)] ?? null;
}

/**
 * Resolves a request path to an absolute path **inside** `root`.
 *
 * Every rejection reason is returned rather than thrown, so the server can turn
 * it into an honest 4xx instead of a stack trace.
 *
 * @param {string} root absolute path of the content directory
 * @param {string} requestPath the part of the URL after the prefix, e.g. `worlds/a.json`
 * @returns {{ ok: true, path: string, relative: string } | { ok: false, reason: string }}
 */
export function safeContentPath(root, requestPath) {
  let decoded;
  try {
    decoded = decodeURIComponent(requestPath);
  } catch {
    return { ok: false, reason: 'the path is not valid percent-encoding' };
  }

  if (decoded.includes('\0')) {
    return { ok: false, reason: 'the path contains a null byte' };
  }

  const relative = decoded.replace(/^\/+/, '');
  if (relative.length === 0) {
    return { ok: false, reason: 'the path is empty' };
  }
  // A leading `/` is how a URL path arrives and means nothing here: it is
  // stripped above, so `/worlds/a.json` addresses the same file as
  // `worlds/a.json`. A Windows drive letter or a backslash is a different
  // matter — it would name a location outside the directory on that platform.
  if (isAbsolute(relative) || /^[a-zA-Z]:/.test(relative) || relative.includes('\\')) {
    return { ok: false, reason: 'the path must be relative to the content directory' };
  }

  const segments = relative.split('/');
  if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) {
    return { ok: false, reason: 'the path may not contain empty or relative segments' };
  }

  const path = resolve(root, relative);
  // Belt and braces: the segment check above already forbids traversal, but the
  // resolved path is what actually gets opened, so that is what gets checked.
  if (path !== root && !path.startsWith(root.endsWith(sep) ? root : root + sep)) {
    return { ok: false, reason: 'the path escapes the content directory' };
  }

  if (contentTypeOf(relative) === null) {
    return {
      ok: false,
      reason: `"${extensionOf(relative) || 'no extension'}" is not an allowed content file type`,
    };
  }

  return { ok: true, path, relative };
}
