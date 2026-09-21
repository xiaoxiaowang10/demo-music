// DOM shortcut
const $ = id => document.getElementById(id)

// 消息提示
function setMessage(text, type) {
  el.message.textContent = text
  el.message.className = type || ''
}

function setApiStatus(text, type) {
  if (!el.apiStatus) return
  el.apiStatus.textContent = text
  el.apiStatus.className = 'api-status ' + (type || '')
}

// 下载进度
function setProgress(text) {
  if (!el.progress) return
  el.progress.textContent = text
}

function fmtBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB']
  let i = 0
  while (bytes >= 1024 && i < units.length - 1) {
    bytes /= 1024
    i++
  }
  return (i === 0 ? Math.round(bytes) : bytes.toFixed(1)) + ' ' + units[i]
}

function wait(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

// HTML 转义
function escapeHtml(str) {
  const map = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }
  return String(str).replace(/[&<>"']/g, c => map[c])
}

// 歌手名
function artistOf(song) {
  return song.singer || song.ar?.map(a => a.name).join('/') || '?'
}

// 专辑名
function albumOf(song) {
  return song.album || song.al?.name || '?'
}

// 从用户输入提取 ID
function extractId(text) {
  text = text.trim()
  if (/^\d+$/.test(text)) return text
  return text.match(/[?&]id=(\d+)/)?.[1]
      || text.match(/(\d{5,})/)?.[1]
      || null
}
