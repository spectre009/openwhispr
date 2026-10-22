// An in-memory filesystem for one Copilot SDK session. The runtime keeps a
// session's journal (the prompt, the transcript and the reply) through it, so
// nothing a user dictates is written to disk; it is dropped with the session.
const path = require("path").posix;

function enoent(target) {
  return Object.assign(new Error(`ENOENT: no such file or directory, '${target}'`), {
    code: "ENOENT",
  });
}

function normalize(target) {
  const normalized = path.normalize(String(target || "/"));
  return normalized.length > 1 ? normalized.replace(/\/+$/, "") : "/";
}

function createMemorySessionFs() {
  const files = new Map();
  const dirs = new Set(["/"]);
  const createdAt = new Date().toISOString();

  function addParents(target) {
    let dir = path.dirname(target);
    while (!dirs.has(dir)) {
      dirs.add(dir);
      dir = path.dirname(dir);
    }
  }

  function entries(dir) {
    const prefix = dir === "/" ? "/" : `${dir}/`;
    const found = new Map();
    const direct = (candidate) =>
      candidate.startsWith(prefix) &&
      candidate !== dir &&
      !candidate.slice(prefix.length).includes("/");
    for (const file of files.keys()) {
      if (direct(file)) found.set(file.slice(prefix.length), "file");
    }
    for (const sub of dirs) {
      if (direct(sub)) found.set(sub.slice(prefix.length), "directory");
    }
    return found;
  }

  function removeTree(target) {
    files.delete(target);
    dirs.delete(target);
    const prefix = `${target}/`;
    for (const file of [...files.keys()]) if (file.startsWith(prefix)) files.delete(file);
    for (const dir of [...dirs]) if (dir.startsWith(prefix)) dirs.delete(dir);
  }

  return {
    async readFile(target) {
      const key = normalize(target);
      if (!files.has(key)) throw enoent(key);
      return files.get(key);
    },
    async writeFile(target, content) {
      const key = normalize(target);
      addParents(key);
      files.set(key, String(content));
    },
    async appendFile(target, content) {
      const key = normalize(target);
      addParents(key);
      files.set(key, (files.get(key) || "") + String(content));
    },
    async exists(target) {
      const key = normalize(target);
      return files.has(key) || dirs.has(key);
    },
    async stat(target) {
      const key = normalize(target);
      if (files.has(key)) {
        return {
          isFile: true,
          isDirectory: false,
          size: Buffer.byteLength(files.get(key)),
          mtime: createdAt,
          birthtime: createdAt,
        };
      }
      if (dirs.has(key)) {
        return {
          isFile: false,
          isDirectory: true,
          size: 0,
          mtime: createdAt,
          birthtime: createdAt,
        };
      }
      throw enoent(key);
    },
    async mkdir(target) {
      const key = normalize(target);
      addParents(key);
      dirs.add(key);
    },
    async readdir(target) {
      const key = normalize(target);
      if (!dirs.has(key)) throw enoent(key);
      return [...entries(key).keys()];
    },
    async readdirWithTypes(target) {
      const key = normalize(target);
      if (!dirs.has(key)) throw enoent(key);
      return [...entries(key)].map(([name, type]) => ({ name, type }));
    },
    async rm(target, recursive, force) {
      const key = normalize(target);
      if (!files.has(key) && !dirs.has(key)) {
        if (force) return;
        throw enoent(key);
      }
      if (dirs.has(key) && !recursive && entries(key).size > 0) {
        throw Object.assign(new Error(`ENOTEMPTY: directory not empty, '${key}'`), {
          code: "ENOTEMPTY",
        });
      }
      removeTree(key);
    },
    async rename(source, destination) {
      const from = normalize(source);
      const to = normalize(destination);
      if (files.has(from)) {
        addParents(to);
        files.set(to, files.get(from));
        files.delete(from);
        return;
      }
      if (!dirs.has(from)) throw enoent(from);
      addParents(to);
      const prefix = `${from}/`;
      for (const file of [...files.keys()]) {
        if (file.startsWith(prefix)) {
          files.set(to + file.slice(from.length), files.get(file));
          files.delete(file);
        }
      }
      for (const dir of [...dirs]) {
        if (dir === from || dir.startsWith(prefix)) {
          dirs.delete(dir);
          dirs.add(to + dir.slice(from.length));
        }
      }
    },
    // Tests only: the paths the session wrote.
    _paths() {
      return [...files.keys()];
    },
  };
}

module.exports = { createMemorySessionFs };
