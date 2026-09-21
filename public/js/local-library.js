// 本地曲库：用 File System Access API 读取用户选定的音乐文件夹。
// 网易云客户端的标准落盘文件名是「歌手1,歌手2 - 标题.扩展名」，这里按该格式建索引，
// 用于下载前判断「本地是否已有」，以及把新文件直接写回该文件夹。

const AUDIO_EXTS = new Set(['mp3', 'flac', 'm4a', 'aac', 'wav', 'ogg', 'wma', 'ape', 'aiff', 'dsf', 'ncm'])
const IGNORED_FILES = /^(desktop\.ini|thumbs\.db|\.ds_store)$/i
const DUP_SUFFIX_RE = /\s*\((\d{1,2})\)$/
const ARTIST_SPLIT_RE = /[,，/&、+＋|]+/
const KEY_SEP = '|'
const MAX_SCAN_DEPTH = 4
const PROGRESS_EVERY = 200
const WRITE_CHUNK = 8 * 1024 * 1024

const IDB_NAME = 'netease-music-pages'
const IDB_STORE = 'fs-handles'
const IDB_DIR_KEY = 'music-dir'

const library = {
  handle: null,
  index: null,
  writable: false,
  scanning: false,
}

function fsAccessSupported() {
  return typeof window.showDirectoryPicker === 'function'
}

// 文件名解析 --------------------------------------------------------------

// 把全角/半角、大小写、多余空白、歌手分隔符统一后再比较，
// 因为接口返回的是「A/B」，而客户端落盘的是「A,B」。
function normText(text) {
  return String(text || '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim()
}

function normArtist(artist) {
  return normText(artist)
    .split(ARTIST_SPLIT_RE)
    .map(part => part.replace(/^(?:feat|ft|vs|featuring)\.?\s+/, '').trim())
    .filter(Boolean)
    .join('/')
}

function firstArtist(artist) {
  return normArtist(artist).split('/')[0] || ''
}

function stripDupSuffix(title) {
  const stripped = title.replace(DUP_SUFFIX_RE, '').trim()
  return stripped || title
}

function trackKey(artist, title) {
  const name = normText(title)
  if (!name) return ''
  return normArtist(artist) + KEY_SEP + name
}

// 解析「歌手 - 标题.扩展名」；只认音频扩展名，歌词和说明文件直接忽略。
function parseLocalFile(filename) {
  const dot = filename.lastIndexOf('.')
  if (dot <= 0) return null

  const ext = filename.slice(dot + 1).toLowerCase()
  if (!AUDIO_EXTS.has(ext)) return null

  const stem = filename.slice(0, dot)
  const sep = stem.indexOf(' - ')
  const artist = sep > 0 ? stem.slice(0, sep).trim() : ''
  const title = (sep > 0 ? stem.slice(sep + 3) : stem).trim()
  if (!title) return null

  return { filename, artist, title, ext }
}

// 索引 --------------------------------------------------------------------

function createIndex() {
  const exact = new Map()
  const titles = new Map()
  const index = { files: 0, scanned: 0, exact, titles }

  index.add = function (entry) {
    index.files++
    put(exact, trackKey(entry.artist, entry.title), entry)
    put(exact, trackKey(entry.artist, stripDupSuffix(entry.title)), entry)
    put(exact, trackKey(firstArtist(entry.artist), entry.title), entry)
    put(titles, normText(entry.title), entry)
  }

  // mode: exact 只认「歌手+歌名」，loose 额外把同名不同歌手也算作已下载。
  index.match = function (song, mode) {
    const title = normText(song.title || song.name)
    if (!title) return null

    const keys = [
      trackKey(song.artist, song.title || song.name),
      trackKey(song.artist, stripDupSuffix(title)),
      trackKey(firstArtist(song.artist), title),
    ]
    for (const key of keys) {
      const hits = key && exact.get(key)
      if (hits) return { level: 'exact', entry: hits[0] }
    }

    if (mode === 'loose') {
      const hits = titles.get(title)
      if (hits) return { level: 'title', entry: hits[0] }
    }
    return null
  }

  return index
}

function put(map, key, entry) {
  if (!key) return
  const hits = map.get(key)
  if (hits) hits.push(entry)
  else map.set(key, [entry])
}

async function scanDirectory(handle, onProgress) {
  const index = createIndex()
  await walk(handle, 0)
  return index

  async function walk(dir, depth) {
    for await (const [name, entry] of dir.entries()) {
      if (name.startsWith('.')) continue

      if (entry.kind === 'directory') {
        if (depth < MAX_SCAN_DEPTH) await walk(entry, depth + 1)
      } else if (!IGNORED_FILES.test(name)) {
        index.scanned++
        const parsed = parseLocalFile(name)
        if (parsed) index.add(parsed)
        if (onProgress && index.scanned % PROGRESS_EVERY === 0) onProgress(index)
      }
    }
  }
}

function noteSavedFile(filename) {
  if (!library.index) return
  const parsed = parseLocalFile(filename)
  if (parsed) library.index.add(parsed)
}

// 授权与句柄持久化 --------------------------------------------------------

async function pickDirectoryHandle() {
  const handle = await window.showDirectoryPicker({ id: 'music-dir', startIn: 'music' })
  const granted = await verifyPermission(handle, true)
  if (!granted) throw new Error('未授予读写权限')
  return handle
}

async function verifyPermission(handle, ask) {
  const opts = { mode: 'readwrite' }
  if (typeof handle.queryPermission !== 'function') return true

  if ((await handle.queryPermission(opts)) === 'granted') return true
  if (!ask || typeof handle.requestPermission !== 'function') return false
  return (await handle.requestPermission(opts)) === 'granted'
}

async function rememberDirectoryHandle(handle) {
  await idbSet(IDB_DIR_KEY, handle)
}

async function restoreDirectoryHandle() {
  return idbGet(IDB_DIR_KEY)
}

async function forgetDirectoryHandle() {
  await idbDelete(IDB_DIR_KEY)
}

function openIdb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(IDB_NAME, 1)
    req.onupgradeneeded = () => req.result.createObjectStore(IDB_STORE)
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error || new Error('IndexedDB 不可用'))
  })
}

function runIdb(mode, fn) {
  return openIdb().then(db => new Promise((resolve, reject) => {
    const tx = db.transaction(IDB_STORE, mode)
    const req = fn(tx.objectStore(IDB_STORE))
    tx.oncomplete = () => resolve(req && req.result)
    tx.onerror = () => reject(tx.error)
    tx.onabort = () => reject(tx.error || new Error('IndexedDB 事务中断'))
  }).finally(() => db.close()))
}

function idbGet(key) {
  return runIdb('readonly', store => store.get(key)).catch(() => null)
}

function idbSet(key, value) {
  return runIdb('readwrite', store => store.put(value, key)).catch(() => null)
}

function idbDelete(key) {
  return runIdb('readwrite', store => store.delete(key)).catch(() => null)
}

// 直接写入文件夹 ----------------------------------------------------------

// 存在即改名，绝不覆盖：即使去重判断漏了，也不会毁掉用户已有的文件。
async function createFileHandle(dirHandle, filename) {
  const dot = filename.lastIndexOf('.')
  const stem = dot > 0 ? filename.slice(0, dot) : filename
  const ext = dot > 0 ? filename.slice(dot) : ''

  for (let i = 0; i < 100; i++) {
    const name = i ? stem + ' (' + (i + 1) + ')' + ext : filename
    try {
      await dirHandle.getFileHandle(name)
    } catch {
      return dirHandle.getFileHandle(name, { create: true })
    }
  }
  throw new Error('无法生成不重复的文件名')
}

// 流式落盘，避免把整首无损音频读进内存。
async function writeAudioFile(dirHandle, filename, url, onProgress) {
  const res = await fetch(url)
  if (!res.ok) throw new Error('音频请求失败: ' + res.status)

  // 取到地址之后再建文件，否则失败的下载会留下 0 字节文件并被当成「已下载」
  const target = await createFileHandle(dirHandle, filename)
  const total = Number(res.headers.get('content-length')) || 0
  const writable = await target.createWritable()
  let written = 0

  try {
    if (res.body && typeof res.body.getReader === 'function') {
      const reader = res.body.getReader()
      for (;;) {
        const chunk = await reader.read()
        if (chunk.done) break
        if (!chunk.value || !chunk.value.byteLength) continue
        await writable.write(chunk.value)
        written += chunk.value.byteLength
        if (onProgress) onProgress(written, total)
      }
    } else {
      const blob = await res.blob()
      for (let offset = 0; offset < blob.size; offset += WRITE_CHUNK) {
        const part = blob.slice(offset, Math.min(offset + WRITE_CHUNK, blob.size))
        await writable.write(part)
        written += part.size
        if (onProgress) onProgress(written, blob.size)
      }
    }

    if (!written) throw new Error('音频内容为空')
    await writable.close()
  } catch (err) {
    // abort 会丢弃未写完的内容，再把空文件删掉
    try { await writable.abort() } catch { /* 已关闭 */ }
    try { await dirHandle.removeEntry(target.name) } catch { /* 删不掉就留给用户 */ }
    throw err
  }

  return { filename: target.name, size: written }
}
