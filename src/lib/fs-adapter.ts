/**
 * Host filesystem adapter.
 *
 * Tools honour the DSH "read before write" observation policy: every mutation
 * goes through {@link HostFs}, and the service-backed adapter reads a target
 * before overwriting it. When the `fs` service (a `@deepseek-ai/dsh-fs`
 * `FileSystem`) is available on the context it is preferred; otherwise the
 * plain Node adapter is used, which also powers offline smoke tests. Directory
 * creation and binary writes (the `.skill` artifact) fall back to Node because
 * the fs service exposes text-only mutations.
 */

import { mkdir, readFile, writeFile, readdir, rm, stat } from 'node:fs/promises'
import { dirname } from 'node:path'

export type FsTargetType = 'file' | 'dir' | 'other'

export interface FsStat {
  readonly type: FsTargetType
  readonly size: number
}

/** Minimal host-facing filesystem surface used by every skill-creator lib. */
export interface HostFs {
  stat(path: string): Promise<FsStat | undefined>
  readText(path: string): Promise<string>
  writeText(path: string, content: string): Promise<void>
  writeBin(path: string, data: Uint8Array): Promise<void>
  listDir(path: string): Promise<string[]>
  mkdirp(path: string): Promise<void>
  remove(path: string): Promise<void>
}

function abortIf(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new Error('operation aborted')
}

/** Duck-typed subset of the `@deepseek-ai/dsh-fs` FileSystem service. */
export interface FileSystemLike {
  resolve(path: string, opts?: { cwd?: string; signal?: AbortSignal }): Promise<{ targetKey: string; displayPath: string }>
  stat(target: unknown, signal?: AbortSignal): Promise<{ type: string; size?: number } | undefined>
  readText(target: unknown, signal?: AbortSignal): Promise<string>
  writeText(target: unknown, content: string, expected?: unknown, signal?: AbortSignal): Promise<unknown>
  listDir(target: unknown, signal?: AbortSignal): Promise<{ name: string; type: string }[]>
}

/** Return whether a value looks like the fs service. */
export function isFileSystemLike(value: unknown): value is FileSystemLike {
  if (typeof value !== 'object' || value === null) return false
  const candidate = value as FileSystemLike
  return typeof candidate.resolve === 'function'
    && typeof candidate.stat === 'function'
    && typeof candidate.readText === 'function'
    && typeof candidate.writeText === 'function'
}

/** Pure Node host adapter (also used by offline tests). */
export function nodeHostFs(): HostFs {
  return {
    async stat(path) {
      try {
        const info = await stat(path)
        const type: FsTargetType = info.isDirectory() ? 'dir' : info.isFile() ? 'file' : 'other'
        return { type, size: info.size }
      } catch (error) {
        if (isAbsent(error)) return undefined
        throw error
      }
    },
    async readText(path) {
      return await readFile(path, { encoding: 'utf8' })
    },
    async writeText(path, content) {
      await mkdir(dirname(path), { recursive: true })
      await writeFile(path, content, { encoding: 'utf8' })
    },
    async writeBin(path, data) {
      await mkdir(dirname(path), { recursive: true })
      await writeFile(path, data)
    },
    async listDir(path) {
      const entries = await readdir(path, { encoding: 'utf8' })
      return Array.from(entries)
    },
    async mkdirp(path) {
      await mkdir(path, { recursive: true })
    },
    async remove(path) {
      await rm(path, { recursive: true, force: true })
    },
  }
}

function isAbsent(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error
    && (error.code === 'ENOENT' || error.code === 'ENOTDIR')
}

/** Adapter over the fs service; mutations honour read-before-write. */
export function serviceHostFs(fs: FileSystemLike, signal?: AbortSignal): HostFs {
  return {
    async stat(path) {
      abortIf(signal)
      const target = await fs.resolve(path, { signal })
      const info = await fs.stat(target, signal)
      if (info === undefined) return undefined
      const type: FsTargetType = info.type === 'file' ? 'file' : info.type === 'directory' ? 'dir' : 'other'
      return { type, size: info.size ?? 0 }
    },
    async readText(path) {
      abortIf(signal)
      const target = await fs.resolve(path, { signal })
      return await fs.readText(target, signal)
    },
    async writeText(path, content) {
      abortIf(signal)
      const target = await fs.resolve(path, { signal })
      const existing = await fs.stat(target, signal)
      if (existing !== undefined) {
        // Observation policy: read the current content before overwriting it.
        await fs.readText(target, signal)
      }
      await fs.writeText(target, content, undefined, signal)
    },
    async writeBin(path, data) {
      // The fs service is text-only; binary artifacts are host-side.
      abortIf(signal)
      await mkdir(dirname(path), { recursive: true })
      await writeFile(path, data)
    },
    async listDir(path) {
      abortIf(signal)
      const target = await fs.resolve(path, { signal })
      const entries = await fs.listDir(target, signal)
      return entries.map((entry) => entry.name)
    },
    async mkdirp(path) {
      await mkdir(path, { recursive: true })
    },
    async remove(path) {
      await rm(path, { recursive: true, force: true })
    },
  }
}

/**
 * Pick the best adapter for a tool context: the fs service when present,
 * otherwise plain Node. `signal` cancels service reads/writes.
 */
export function makeHostFs(ctx: { get(name: string): unknown } | undefined, signal?: AbortSignal): HostFs {
  if (ctx !== undefined) {
    const service = ctx.get('fs')
    if (isFileSystemLike(service)) return serviceHostFs(service, signal)
  }
  return nodeHostFs()
}