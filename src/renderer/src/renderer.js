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
const playerSummary = document.getElementById('player-summary')
const summaryBadges = document.getElementById('summary-badges')
const summaryOwned = document.getElementById('summary-owned')
const progressContainer = document.getElementById('progress-container')
const progressFill = document.getElementById('progress-fill')
const statusText = document.getElementById('status-text')
const progressPercent = document.getElementById('progress-percent')
const progressStage = document.getElementById('progress-stage')
const serverStatus = document.getElementById('server-status')
const serverDot = document.getElementById('server-dot')
const modalOverlay = document.getElementById('modal-overlay')
const modalCard = document.getElementById('modal-card')
const modalTitle = document.getElementById('modal-title')
const modalMessage = document.getElementById('modal-message')
const modalOk = document.getElementById('modal-ok')

let mclcAuth = null
let launchDirectory = null
let modalResolver = null

function showModal({ title = '알림', message = '', variant = 'info' }) {
  return new Promise((resolve) => {
    modalResolver = resolve

    modalTitle.textContent = title
    modalMessage.textContent = message

    modalCard.classList.remove('is-error', 'is-success')
    if (variant === 'error') modalCard.classList.add('is-error')
    if (variant === 'success') modalCard.classList.add('is-success')

    modalOverlay.classList.remove('hidden')
    modalOverlay.setAttribute('aria-hidden', 'false')
    modalOk.focus()
  })
}

function hideModal() {
  modalOverlay.classList.add('hidden')
  modalOverlay.setAttribute('aria-hidden', 'true')
  const resolver = modalResolver
  modalResolver = null
  resolver?.()
}

modalOk.addEventListener('click', () => {
  hideModal()
})

modalOverlay.addEventListener('click', (event) => {
  if (event.target === modalOverlay) {
    hideModal()
  }
})

window.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && !modalOverlay.classList.contains('hidden')) {
    hideModal()
  }
})

// ===== Initial State =====
function init() {
  serverStatus.textContent = '서버 - 오프라인'
  serverDot.classList.remove('online')
  progressFill.style.width = '0%'
  progressPercent.textContent = '0%'
  progressStage.textContent = 'PREPARE'
  hydrateLaunchDirectory()
}

async function hydrateLaunchDirectory() {
  try {
    const selectedPath = await window.api.getLaunchDirectory()
    launchDirectory = selectedPath || null
  } catch (error) {
    console.error('Failed to load launch directory', error)
  }
}

async function ensureLaunchDirectorySelected() {
  if (launchDirectory) return true

  const result = await window.api.chooseLaunchDirectory()
  if (!result || result.canceled) {
    await showModal({
      title: '설치 위치 필요',
      message: '설치 위치를 먼저 선택해야 게임을 시작할 수 있습니다.',
      variant: 'error'
    })
    return false
  }
  if (!result.success) {
    await showModal({
      title: '설치 위치 오류',
      message: result.error || '설치 위치 선택에 실패했습니다.',
      variant: 'error'
    })
    return false
  }

  launchDirectory = result.launchDirectory
  await showModal({
    title: '설치 위치 설정 완료',
    message: `설치 위치가 설정되었습니다:\n${launchDirectory}`,
    variant: 'success'
  })
  return true
}

async function updatePlayerSummary(profile) {
  if (!profile) return

  summaryBadges.textContent = '배지: -'
  summaryOwned.textContent = '도감 보유종: -'
  playerSummary.classList.add('hidden')

  try {
    const summary = await window.api.getPlayerSummary({
      uuid: profile.id,
      nickname: profile.name
    })

    if (!summary || !summary.enabled) return

    summaryBadges.textContent = `배지: ${summary.badgesCount}`
    summaryOwned.textContent = `도감 보유종: ${summary.ownedSpeciesCount}`
    playerSummary.classList.remove('hidden')
  } catch (error) {
    console.error('Failed to load player summary', error)
  }
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
    updatePlayerSummary(result.profile)
  } else {
    await showModal({
      title: '로그인 실패',
      message: String(result.error || '알 수 없는 오류'),
      variant: 'error'
    })
    btnLogin.disabled = false
    btnLogin.querySelector('span').textContent = 'LOGIN'
  }
})

// ===== Start Adventure (Play) =====
btnPlay.addEventListener('click', async () => {
  if (!mclcAuth) return

  const hasLaunchDirectory = await ensureLaunchDirectorySelected()
  if (!hasLaunchDirectory) return
  
  btnPlay.disabled = true
  btnPlay.querySelector('span').textContent = '모험 준비 중...'
  progressContainer.classList.remove('hidden')
  
  const result = await window.api.launchGame({ mclcAuth, launchRoot: launchDirectory })
  
  if (!result.success) {
    await showModal({
      title: '실행 실패',
      message: String(result.error || '알 수 없는 오류'),
      variant: 'error'
    })
    btnPlay.disabled = false
    btnPlay.querySelector('span').textContent = 'START ADVENTURE'
    progressContainer.classList.add('hidden')
  }
})

// ===== Navigation =====
btnSettings.addEventListener('click', () => {
  window.api
    .chooseLaunchDirectory()
    .then((result) => {
      if (!result || result.canceled) return
      if (!result.success) {
        void showModal({
          title: '설치 위치 오류',
          message: result.error || '설치 위치 선택에 실패했습니다.',
          variant: 'error'
        })
        return
      }
      if (result.success) {
        launchDirectory = result.launchDirectory
        void showModal({
          title: '설치 위치 변경 완료',
          message: `설치 위치가 변경되었습니다:\n${launchDirectory}`,
          variant: 'success'
        })
      }
    })
    .catch((error) => {
      console.error('Failed to choose launch directory', error)
      void showModal({
        title: '설치 위치 오류',
        message: '설치 위치 변경에 실패했습니다.',
        variant: 'error'
      })
    })
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
  progressPercent.textContent = `${percent}%`
  progressStage.textContent = 'DOWNLOAD'
  statusText.textContent = `데이터 동기화: ${percent}% [${progress.type}]`
})

window.api.onInstallProgress((payload) => {
  if (!payload) return
  const percent = Math.max(0, Math.min(100, Number(payload.percent) || 0))
  progressFill.style.width = percent + '%'
  progressPercent.textContent = `${percent}%`
  progressStage.textContent = payload.stage || 'INSTALL'
  statusText.textContent = payload.message || `설치 진행 중... ${percent}%`
})

window.api.onGameClosed((code) => {
  btnPlay.disabled = false
  btnPlay.querySelector('span').textContent = 'START ADVENTURE'
  progressContainer.classList.add('hidden')
  progressFill.style.width = '0%'
  progressPercent.textContent = '0%'
  progressStage.textContent = 'PREPARE'
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
