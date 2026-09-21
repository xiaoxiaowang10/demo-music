// DOM 引用 ----------------------------------------------------------------

const el = {
  mode:    $('mode'),
  quality: $('quality'),
  target:  $('target'),
  submit:  $('submit'),
  message: $('message'),
  apiStatus: $('apiStatus'),
  apiPanel: $('apiPanel'),
  apiProvider: $('apiProvider'),
  apiRefresh: $('apiRefresh'),
  loading: $('loading'),

  libPick:    $('libPick'),
  libRescan:  $('libRescan'),
  libForget:  $('libForget'),
  libStatus:  $('libStatus'),
  matchMode:  $('matchMode'),
  skipExisting: $('skipExisting'),

  single:   $('singleCard'),
  cover:    $('singleCover'),
  title:    $('singleTitle'),
  artist:   $('singleMeta'),
  extra:    $('singleExtra'),
  match:    $('singleMatch'),
  player:   $('singleAudio'),
  download: $('singleDownload'),

  playlist: $('playlistCard'),
  plcover:  $('playlistCover'),
  pltitle:  $('playlistTitle'),
  plmeta:   $('playlistMeta'),
  plextra:  $('playlistExtra'),
  tracks:   $('tracks'),
  delay:    $('delay'),
  batchDl:  $('batchDl'),
  batchStop: $('batchStop'),
  progress: $('progress'),
  filter:   $('trackFilter'),
  hideDone: $('hideDownloaded'),
  pickMissing: $('pickMissing'),
  clearPick: $('clearPick'),
  summary:   $('trackSummary'),
}

let state = {
  song: null,
  tracks: [],
  selected: new Set(),
  touched: new Set(),
  busy: false,
  stop: false,
}

// 初始化 ------------------------------------------------------------------

el.submit.disabled = true
setApiStatus('接口检查中...')

authenticate().then(status => {
  el.submit.disabled = false
  renderApiProviders(status)
}).catch(err => {
  el.submit.disabled = true
  setMessage('认证失败: ' + err.message, 'err')
  setApiStatus('接口不可用', 'err')
  renderApiProviders(getApiStatus())
})

initLibrary()

// 事件绑定 ----------------------------------------------------------------

el.submit.onclick = handleParse
el.target.onkeydown = e => { if (e.key === 'Enter') handleParse() }

el.mode.onchange = () => {
  el.single.hidden = true
  el.playlist.hidden = true
  el.message.textContent = ''
}

el.libPick.onclick = chooseLibraryFolder
el.libRescan.onclick = () => rescanLibrary()
el.libForget.onclick = forgetLibrary

el.matchMode.onchange = () => {
  annotateTracks()
  recomputeSelection()
  renderTracks()
}

el.skipExisting.onchange = () => {
  recomputeSelection()
  renderTracks()
}

el.download.onclick = async () => {
  const song = state.song
  if (!song?.url) return

  el.download.disabled = true
  try {
    await ensureWritable()
    const filename = audioFilename(song.artist, song.name, song.url, song.type)
    const out = await deliverAudio(song.url, filename)
    setMessage(out.mode === 'saved' ? '已写入本地文件夹: ' + out.filename : '已开始下载（浏览器）', 'ok')
    renderSingleMatch(song)
  } catch (err) {
    setMessage('下载失败: ' + err.message, 'err')
  } finally {
    el.download.disabled = false
  }
}

el.batchDl.onclick = batchDownload
el.batchStop.onclick = () => {
  state.stop = true
  el.batchStop.disabled = true
}

el.filter.oninput = renderTracks
el.hideDone.onchange = renderTracks
el.pickMissing.onclick = () => {
  state.touched = new Set()
  state.selected = defaultSelection()
  renderTracks()
}
el.clearPick.onclick = () => {
  state.selected = new Set()
  state.touched = new Set(state.tracks.map((_, i) => i))
  renderTracks()
}

el.tracks.onchange = e => {
  const box = e.target.closest('input.pick')
  if (!box) return
  const idx = Number(box.dataset.idx)
  state.touched.add(idx)
  if (box.checked) state.selected.add(idx)
  else state.selected.delete(idx)
  renderSummary()
}

// 曲目列表中单个下载按钮
el.tracks.onclick = async e => {
  const btn = e.target.closest('button[data-idx]')
  if (!btn || state.busy) return

  const idx = Number(btn.dataset.idx)
  const song = state.tracks[idx]
  btn.disabled = true
  btn.textContent = '解析中'
  try {
    await ensureWritable()
    const out = await downloadOne(song, (written, total) => {
      setProgress(fmtBytes(written) + (total ? ' / ' + fmtBytes(total) : ''))
    })
    song.state = out.mode === 'missing' ? 'missing' : (out.mode === 'saved' ? 'saved' : 'written')
    if (out.fallbackCode === 'NotAllowedError' || out.fallbackCode === 'SecurityError') library.writable = false
    btn.textContent = buttonLabel(song)
    await wait(1200)
  } catch (err) {
    song.state = 'failed'
    btn.textContent = '失败'
    setMessage('下载失败: ' + err.message, 'err')
    await wait(1200)
  } finally {
    btn.disabled = false
    btn.textContent = buttonLabel(song)
    setProgress('等待')
    renderTracks()
  }
}

el.apiProvider.onchange = () => {
  try {
    const status = selectApiProvider(el.apiProvider.value)
    renderApiProviders(status)
  } catch (err) {
    setApiStatus(err.message, 'err')
  }
}

el.apiRefresh.onclick = async () => {
  el.submit.disabled = true
  el.apiRefresh.disabled = true
  setApiStatus('接口检查中...')

  try {
    const status = await authenticate()
    renderApiProviders(status)
    el.submit.disabled = false
  } catch (err) {
    setMessage('认证失败: ' + err.message, 'err')
    setApiStatus('接口不可用', 'err')
    renderApiProviders(getApiStatus())
  } finally {
    el.apiRefresh.disabled = false
  }
}

// 主流程 ------------------------------------------------------------------

async function handleParse() {
  const id = extractId(el.target.value)
  el.single.hidden = true
  el.playlist.hidden = true
  setMessage('')
  if (!id) return setMessage('无法识别 ID', 'err')

  el.submit.disabled = true
  el.loading.hidden = false
  try {
    if (el.mode.value === 'single') {
      await parseSong(id)
    } else {
      await parsePlaylist(id)
    }
  } catch (err) {
    setMessage(err.message, 'err')
  }
  el.submit.disabled = false
  el.loading.hidden = true
}

async function parseSong(id) {
  const [info, link] = await Promise.all([
    api('getSongInfo', { id }),
    api('getSongUrl', { id, level: el.quality.value }),
  ])
  if (!info.data) throw new Error('解析失败')

  const name = info.data.name || '?'
  const artist = artistOf(info.data)
  const url = link.data?.url

  state.song = { id, name, artist, album: albumOf(info.data), url, type: link.data?.type }

  el.cover.src = info.data.picimg || ''
  el.title.textContent = name
  el.artist.textContent = artist
  el.extra.textContent = (info.data.duration || '--:--') + ' · ' + el.quality.selectedOptions[0].textContent
  el.player.src = url || ''
  el.download.disabled = !url
  el.single.hidden = false

  renderSingleMatch(state.song)
  setMessage(url ? 'OK' : '暂无下载地址', url ? 'ok' : 'err')
}

function renderSingleMatch(song) {
  if (!library.index) {
    el.match.hidden = true
    el.match.textContent = ''
    return
  }

  const hit = library.index.match({ artist: song.artist, title: song.name }, el.matchMode.value)
  el.match.hidden = false
  el.match.className = 'lib-status' + (hit ? ' ok' : '')
  el.match.textContent = hit
    ? '本地已有: ' + hit.entry.filename + (hit.level === 'title' ? '（同名不同歌手）' : '')
    : '本地曲库（' + library.index.files + ' 首）中没有这首'
}

async function parsePlaylist(id) {
  const res = await api('getPlaylist', { id })
  const data = res.data
  if (!data) throw new Error('歌单解析失败')

  state.tracks = data.songs || data.tracks || []
  state.stop = false

  el.plcover.src = data.coverImage || data.picUrl || ''
  el.pltitle.textContent = data.name || '?'
  el.plmeta.textContent = (data.creator?.nickname || data.creator?.name || '?') + ' · ' + state.tracks.length + ' 首'
  el.plextra.textContent = data.description || (data.playCount ? Number(data.playCount).toLocaleString() + ' 次播放' : '')

  annotateTracks()
  state.touched = new Set()
  state.selected = defaultSelection()
  renderTracks()

  el.playlist.hidden = false
  setMessage('OK', 'ok')
}

// 去重 / 筛选 --------------------------------------------------------------

// 给每首歌算出：本地命中情况、歌单内是否重复、以及默认是否入选下载队列。
function annotateTracks() {
  const mode = el.matchMode.value
  const ids = new Set()
  const keys = new Set()

  for (const song of state.tracks) {
    song.artist = artistOf(song)
    song.album = albumOf(song)
    song.local = library.index?.match({ artist: song.artist, title: song.name }, mode) || null
    song.already = !!song.local && (song.local.level === 'exact' || mode === 'loose')

    const key = trackKey(song.artist, song.name)
    const idKey = song.id == null ? '' : String(song.id)
    song.dup = (idKey && ids.has(idKey)) || keys.has(key)
    if (idKey) ids.add(idKey)
    keys.add(key)

    song.state = null
  }
}

function skipReason(song) {
  if (song.dup) return 'dup'
  if (song.already && el.skipExisting.checked) return 'local'
  return null
}

function defaultSelection() {
  const picked = new Set()
  state.tracks.forEach((song, i) => {
    if (!skipReason(song)) picked.add(i)
  })
  return picked
}

// 切换匹配方式/跳过开关时按新规则重算队列，但用户手动勾选过的行保持不变。
function recomputeSelection() {
  const picked = defaultSelection()
  state.tracks.forEach((_, i) => {
    if (!state.touched.has(i)) return
    if (state.selected.has(i)) picked.add(i)
    else picked.delete(i)
  })
  state.selected = picked
}

function visibleTracks() {
  const q = normText(el.filter.value)
  return state.tracks
    .map((song, index) => ({ song, index }))
    .filter(({ song }) => {
      if (el.hideDone.checked && (song.already || song.dup)) return false
      if (!q) return true
      return normText(song.name + ' ' + song.artist + ' ' + song.album).includes(q)
    })
}

function renderTracks() {
  const rows = visibleTracks()
  el.tracks.innerHTML = rows.length
    ? rows.map(({ song, index }) => trackRow(song, index)).join('')
    : '<div class="track empty">' + (state.tracks.length ? '没有符合筛选条件的歌曲' : '歌单为空') + '</div>'

  renderSummary()
}

function trackRow(song, i) {
  const badges = []
  if (song.dup) badges.push('<span class="badge dup">歌单内重复</span>')
  if (song.local) {
    badges.push(song.local.level === 'exact'
      ? '<span class="badge have">本地已有 · ' + escapeHtml(song.local.entry.filename) + '</span>'
      : '<span class="badge maybe">本地同名 · ' + escapeHtml(song.local.entry.filename) + '</span>')
  }
  if (song.state === 'missing') badges.push('<span class="badge missing">无下载地址</span>')
  if (song.state === 'saved') badges.push('<span class="badge saved">已写入文件夹</span>')
  if (song.state === 'written') badges.push('<span class="badge saved">已浏览器下载</span>')
  if (song.state === 'failed') badges.push('<span class="badge fail">失败</span>')

  const title = escapeHtml(song.name || '?')
  return `
      <div class="track${skipReason(song) ? ' dim' : ''}" data-row="${i}">
        <input class="pick" type="checkbox" data-idx="${i}"${state.selected.has(i) ? ' checked' : ''} aria-label="选择 ${title}">
        <span class="idx">${String(i + 1).padStart(2, '0')}</span>
        <div class="tinfo">
          <strong>${title}</strong>
          <p>${escapeHtml(song.artist)} · ${escapeHtml(song.album)}</p>
        </div>
        <span class="badges">${badges.join('')}</span>
        <button data-idx="${i}">${buttonLabel(song)}</button>
      </div>`
}

function buttonLabel(song) {
  if (song.state === 'saved' || song.state === 'written') return '完成'
  if (song.state === 'missing') return '无地址'
  return song.already && !song.dup ? '重新下载' : '下载'
}

function renderSummary() {
  if (!state.tracks.length) {
    el.summary.textContent = ''
    return
  }

  const local = state.tracks.filter(s => s.already && !s.dup).length
  const dup = state.tracks.filter(s => s.dup).length
  el.summary.textContent = '共 ' + state.tracks.length + ' 首'
    + (library.index ? ' · 本地已有 ' + local + ' 首' : ' · 未连接本地曲库')
    + (dup ? ' · 歌单内重复 ' + dup + ' 首' : '')
    + ' · 已选 ' + state.selected.size + ' 首'
}

// 批量下载 ----------------------------------------------------------------

async function batchDownload() {
  if (state.busy) return

  const queue = [...state.selected].sort((a, b) => a - b).filter(i => state.tracks[i])
  if (!queue.length) return setMessage('请先勾选要下载的歌曲', 'err')

  // 授权提示必须在这里（点击的同步上下文里）申请，否则循环中 await 之后就弹不出来
  await ensureWritable()
  const skipped = state.tracks.length - queue.length
  const interval = Number(el.delay.value) || 0

  state.busy = true
  state.stop = false
  el.batchDl.disabled = true
  el.batchStop.hidden = false
  el.batchStop.disabled = false
  el.delay.disabled = true

  let saved = 0
  let downloaded = 0
  let failed = 0
  let fallbacks = 0

  try {
    for (const [n, i] of queue.entries()) {
      if (state.stop) break

      const song = state.tracks[i]
      const btn = rowButton(i)
      setProgress((n + 1) + '/' + queue.length + ' · ' + (song.name || '?'))
      if (btn) { btn.disabled = true; btn.textContent = '解析中' }

      try {
        const out = await downloadOne(song, (written, total) => {
          setProgress((n + 1) + '/' + queue.length + ' · ' + fmtBytes(written) + (total ? ' / ' + fmtBytes(total) : ''))
        })
        if (out.mode === 'missing') { song.state = 'missing'; failed++ }
        else if (out.mode === 'saved') { song.state = 'saved'; saved++ }
        else { song.state = 'written'; downloaded++ }
        if (out.fallback) {
          fallbacks++
          // 只有权限类错误才整批降级，单次网络抖动继续尝试直接写盘
          if (out.fallbackCode === 'NotAllowedError' || out.fallbackCode === 'SecurityError') library.writable = false
        }
      } catch {
        song.state = 'failed'
        failed++
      } finally {
        if (btn) { btn.disabled = false; btn.textContent = buttonLabel(song) }
      }

      if (!state.stop && n < queue.length - 1 && interval) await wait(interval)
    }

    const done = saved + downloaded
    setMessage(
      (state.stop ? '已停止 · ' : '完成 · ')
      + '成功 ' + done + ' 首'
      + (saved ? '（写入文件夹 ' + saved + '）' : '')
      + (downloaded ? '（浏览器下载 ' + downloaded + '）' : '')
      + ' · 失败/无地址 ' + failed + ' 首 · 未选 ' + skipped + ' 首'
      + (fallbacks ? ' · ' + fallbacks + ' 首写入失败已转浏览器下载' : ''),
      done || state.stop ? 'ok' : 'err'
    )
  } finally {
    state.busy = false
    state.stop = false
    el.batchDl.disabled = false
    el.batchStop.hidden = true
    el.delay.disabled = false
    el.progress.textContent = '等待'
    renderTracks()
  }
}

async function downloadOne(song, onProgress) {
  const res = await api('getSongUrl', { id: song.id, level: el.quality.value })
  const url = res.data?.url
  if (!url) return { mode: 'missing' }

  const filename = audioFilename(song.artist, song.name, url, res.data.type)
  const out = await deliverAudio(url, filename, onProgress)
  song.url = url
  return out
}

// 有本地文件夹授权就直接写盘，否则退回浏览器下载。
async function deliverAudio(url, filename, onProgress) {
  if (library.handle && library.writable) {
    try {
      const out = await writeAudioFile(library.handle, filename, url, onProgress)
      noteSavedFile(out.filename)
      return { mode: 'saved', filename: out.filename, size: out.size }
    } catch (err) {
      await browserDownload(url, filename)
      return { mode: 'download', filename, fallback: err.message, fallbackCode: err.name }
    }
  }

  await browserDownload(url, filename)
  return { mode: 'download', filename }
}

async function ensureWritable() {
  if (!library.handle || !fsAccessSupported()) {
    library.writable = false
    return false
  }
  if (library.writable) return true

  library.writable = await verifyPermission(library.handle, true)
  if (!library.writable) {
    setLibStatus('已连接 ' + library.handle.name + '（只读）：可跳过已下载，但写入需要授予读写权限。', 'warn')
  }
  return library.writable
}

function rowButton(i) {
  return el.tracks.querySelector('[data-row="' + i + '"] button')
}

// 下载触发 ----------------------------------------------------------------

async function browserDownload(url, filename) {
  try {
    const res = await fetch(url)
    if (!res.ok) throw new Error('音频请求失败')

    const blob = await res.blob()
    const objectUrl = URL.createObjectURL(blob)
    clickDownload(objectUrl, filename)
    setTimeout(() => URL.revokeObjectURL(objectUrl), 30000)
  } catch {
    // 跨域取不到字节流时只能把直链交给浏览器
    clickDownload(url, filename)
  }
}

function clickDownload(url, filename) {
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.rel = 'noopener'
  document.body.append(a)
  a.click()
  a.remove()
}

function audioFilename(artist, name, url, type) {
  const ext = getAudioExt(url, type)
  const base = safeFilename((artist || '?') + ' - ' + (name || '?'))
  // 先截断再拼扩展名，避免把 .flac 切成 .f
  return base.slice(0, Math.max(20, 180 - ext.length)).replace(/[. ]+$/, '') + ext
}

// 接口返回的 type 比链接后缀更可靠（部分直链结尾并没有扩展名）。
function getAudioExt(url, type) {
  const fromType = String(type || '').toLowerCase().replace(/^\./, '')
  if (AUDIO_EXTS.has(fromType)) return '.' + fromType

  try {
    const pathname = new URL(url).pathname
    return pathname.match(/\.(flac|m4a|mp3|wav|aac|ogg|ape|dsf|aiff|wma)(?=$|[?#])/i)?.[0] || '.mp3'
  } catch {
    return url?.match(/\.(flac|m4a|mp3|wav|aac|ogg|ape|dsf|aiff|wma)(?=$|[?#])/i)?.[0] || '.mp3'
  }
}

function safeFilename(filename) {
  return filename
    .replace(/[\\/:*?"<>|\x00-\x1f]+/g, '_')
    .replace(/[. ]+$/, '')
}

// 本地曲库 UI --------------------------------------------------------------

async function initLibrary() {
  if (!fsAccessSupported()) {
    el.libPick.disabled = true
    setLibStatus('当前浏览器不支持文件系统访问 API，无法跳过已下载或直写本地目录。请改用 Chrome / Edge。', 'err')
    return
  }

  const handle = await restoreDirectoryHandle()
  if (!handle) {
    setLibStatus('未选择本地音乐文件夹。选择后可跳过已下载的歌曲，并把文件直接写入该文件夹。')
    return
  }

  library.handle = handle
  el.libRescan.hidden = false
  el.libForget.hidden = false

  if (!(await verifyPermission(handle, false))) {
    setLibStatus('已记住文件夹「' + handle.name + '」，点击「选择音乐文件夹」重新授权。', 'warn')
    return
  }

  await rescanLibrary()
}

async function chooseLibraryFolder() {
  el.libPick.disabled = true
  try {
    const handle = await pickDirectoryHandle()
    library.handle = handle
    library.writable = true
    library.index = null
    await rememberDirectoryHandle(handle)
    el.libRescan.hidden = false
    el.libForget.hidden = false
    await rescanLibrary()
  } catch (err) {
    if (err?.name !== 'AbortError') setLibStatus('选择文件夹失败: ' + (err.message || err.name), 'err')
  } finally {
    el.libPick.disabled = false
  }
}

async function rescanLibrary() {
  if (!library.handle) return
  if (library.scanning) return

  library.scanning = true
  el.libRescan.disabled = true
  el.libPick.disabled = true
  try {
    library.writable = await verifyPermission(library.handle, false)
    const index = await scanDirectory(library.handle, scanned => {
      setLibStatus('扫描中… 已读取 ' + scanned + ' 个文件')
    })
    library.index = index
    setLibStatus(
      '已连接「' + library.handle.name + '」：识别到 ' + index.files + ' 首音频（扫描 ' + index.scanned + ' 个文件）'
      + (library.writable ? '' : ' · 只读，未授予写入权限'),
      'ok'
    )
    if (state.tracks.length) {
      annotateTracks()
      recomputeSelection()
      renderTracks()
    }
  } catch (err) {
    library.index = null
    setLibStatus('扫描失败: ' + (err.message || err.name), 'err')
  } finally {
    library.scanning = false
    el.libRescan.disabled = false
    el.libPick.disabled = false
  }
}

async function forgetLibrary() {
  await forgetDirectoryHandle()
  library.handle = null
  library.index = null
  library.writable = false
  el.libRescan.hidden = true
  el.libForget.hidden = true
  setLibStatus('已移除授权。选择后可跳过已下载的歌曲，并把文件直接写入该文件夹。')
  if (state.tracks.length) {
    annotateTracks()
    recomputeSelection()
    renderTracks()
  }
}

function setLibStatus(text, type) {
  el.libStatus.textContent = text
  el.libStatus.className = 'lib-status' + (type ? ' ' + type : '')
}

function renderApiProviders(status) {
  if (!status?.list?.length) return

  el.apiPanel.hidden = false
  el.apiProvider.innerHTML = status.list.map(item => {
    const label = item.ok ? '可用' : '不可用'
    const reason = item.ok ? '' : ' - ' + escapeHtml(item.error || '检查失败')
    const selected = status.active?.base === item.provider.base ? ' selected' : ''
    const disabled = item.ok ? '' : ' disabled'

    return `<option value="${escapeHtml(item.provider.base)}"${selected}${disabled}>${escapeHtml(item.provider.name)} · ${label}${reason}</option>`
  }).join('')

  if (status.active) {
    setApiStatus('当前接口: ' + status.active.name + ' (' + status.available + '/' + status.total + ' 可用)', 'ok')
  } else {
    setApiStatus('接口不可用', 'err')
  }
}
