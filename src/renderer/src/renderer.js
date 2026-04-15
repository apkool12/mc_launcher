const btnLogin = document.getElementById('btn-login')
const btnPlay = document.getElementById('btn-play')
const btnGuide = document.getElementById('btn-guide')
const btnDiscord = document.getElementById('btn-discord')
const btnSettings = document.getElementById('btn-settings')
const btnRefresh = document.getElementById('btn-refresh')
const userArea = document.getElementById('user-area')
const userName = document.getElementById('user-name')
const userAvatar = document.getElementById('user-avatar')
const userStatus = document.getElementById('user-status')
const progressContainer = document.getElementById('progress-container')
const progressFill = document.getElementById('progress-fill')
const statusText = document.getElementById('status-text')
const serverStatus = document.getElementById('server-status')
const serverDot = document.getElementById('server-dot')

let mclcAuth = null

// ===== Initial State =====
function init() {
  serverStatus.textContent = '서버 - 오프라인'
  serverDot.classList.remove('online')
}

// ===== Login =====
btnLogin.addEventListener('click', async () => {
  btnLogin.disabled = true
  btnLogin.querySelector('span').textContent = '인증 중...'
  
  const result = await window.api.msLogin()
  
  if (result.success) {
    mclcAuth = result.mclcAuth
    userName.textContent = result.profile.name
    userAvatar.src = `https://minotar.net/helm/${result.profile.name}/64`
    
    // Switch to play mode
    btnLogin.classList.add('hidden')
    btnPlay.classList.remove('hidden')
    userArea.classList.remove('hidden')
  } else {
    alert('로그인 실패: ' + result.error)
    btnLogin.disabled = false
    btnLogin.querySelector('span').textContent = 'LOGIN'
  }
})

// ===== Start Adventure (Play) =====
btnPlay.addEventListener('click', async () => {
  if (!mclcAuth) return
  
  btnPlay.disabled = true
  btnPlay.querySelector('span').textContent = '모험 준비 중...'
  progressContainer.classList.remove('hidden')
  
  const result = await window.api.launchGame({ mclcAuth })
  
  if (!result.success) {
    alert('실행 실패: ' + result.error)
    btnPlay.disabled = false
    btnPlay.querySelector('span').textContent = 'START ADVENTURE'
    progressContainer.classList.add('hidden')
  }
})

// ===== Navigation =====
btnSettings.addEventListener('click', () => {
  console.log('Settings opened')
})

btnGuide.addEventListener('click', () => {
  window.open('https://wiki.cobblemon.com/', '_blank')
})

btnDiscord.addEventListener('click', () => {
  window.open('https://discord.gg/cobblemon', '_blank')
})

btnRefresh.addEventListener('click', () => {
  location.reload()
})

// ===== IPC Events =====
window.api.onStatusUpdate((status) => {
  statusText.textContent = status
})

window.api.onProgress((progress) => {
  const percent = Math.round((progress.task / progress.total) * 100)
  progressFill.style.width = percent + '%'
  statusText.textContent = `데이터 동기화: ${percent}% [${progress.type}]`
})

window.api.onGameClosed((code) => {
  btnPlay.disabled = false
  btnPlay.querySelector('span').textContent = 'START ADVENTURE'
  progressContainer.classList.add('hidden')
  userStatus.textContent = '모험 종료 (코드: ' + code + ')'
  setTimeout(() => {
    userStatus.textContent = '여행 준비 완료'
  }, 5000)
})

// [NEW] Actual Server Status Update
window.api.onServerStatus((online) => {
  if (online) {
    serverStatus.textContent = '서버 - 온라인'
    serverDot.classList.add('online')
  } else {
    serverStatus.textContent = '서버 - 오프라인'
    serverDot.classList.remove('online')
  }
})

init()
