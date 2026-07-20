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
const summaryBalance = document.getElementById('summary-balance')
const summarySeason = document.getElementById('summary-season')
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
const settingsOverlay = document.getElementById('settings-overlay')
const settingsClose = document.getElementById('settings-close')
const settingsCancel = document.getElementById('settings-cancel')
const settingsSave = document.getElementById('settings-save')
const settingsBrowse = document.getElementById('settings-browse')
const settingsPath = document.getElementById('settings-path')
const settingsServer = document.getElementById('settings-server')
const ramMin = document.getElementById('ram-min')
const ramMax = document.getElementById('ram-max')
const autoConnect = document.getElementById('auto-connect')
const minecraftLanguage = document.getElementById('minecraft-language')
const masterVolume = document.getElementById('master-volume')
const musicVolume = document.getElementById('music-volume')
const masterVolumeValue = document.getElementById('master-volume-value')
const musicVolumeValue = document.getElementById('music-volume-value')

let mclcAuth = null
let launchDirectory = null
let modalResolver = null
let launcherSettings = {
  memoryMinGb: 2,
  memoryMaxGb: 4,
  autoConnect: true,
  masterVolume: 100,
  musicVolume: 30,
  minecraftLanguage: 'ko_kr'
}

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
  if (event.key === 'Escape' && !settingsOverlay.classList.contains('hidden')) {
    closeSettingsPanel()
    return
  }

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
  hydrateLauncherSettings()
  restoreLogin()

  window.api.onUpdateReady(() => {
    showModal({
      title: '업데이트 준비 완료',
      message: '새 버전이 다운로드되었습니다. 런처를 재시작하면 적용됩니다.',
      variant: 'success'
    })
  })
}

function clampNumber(value, min, max, fallback) {
  const number = Number(value)
  if (!Number.isFinite(number)) return fallback
  return Math.max(min, Math.min(max, number))
}

function formatServer(server) {
  if (!server?.host) return 'bytemc.kro.kr:25565'
  if (!server.port || Number(server.port) === 25565) return server.host
  return `${server.host}:${server.port}`
}

function renderSettings(settings = launcherSettings, server) {
  launcherSettings = {
    ...launcherSettings,
    ...settings,
    memoryMinGb: clampNumber(settings.memoryMinGb, 1, 12, 2),
    memoryMaxGb: clampNumber(settings.memoryMaxGb, 2, 16, 4),
    autoConnect: settings.autoConnect !== false,
    masterVolume: clampNumber(settings.masterVolume, 0, 100, 100),
    musicVolume: clampNumber(settings.musicVolume, 0, 100, 30),
    minecraftLanguage: ['ko_kr', 'en_us'].includes(
      String(settings.minecraftLanguage || '').toLowerCase()
    )
      ? String(settings.minecraftLanguage).toLowerCase()
      : 'ko_kr'
  }

  if (launcherSettings.memoryMaxGb < launcherSettings.memoryMinGb) {
    launcherSettings.memoryMaxGb = launcherSettings.memoryMinGb
  }

  launchDirectory = launcherSettings.launchDirectory || launchDirectory || null
  settingsPath.textContent = launchDirectory || '선택되지 않음'
  settingsServer.textContent = formatServer(server)
  ramMin.value = String(launcherSettings.memoryMinGb)
  ramMax.value = String(launcherSettings.memoryMaxGb)
  autoConnect.checked = launcherSettings.autoConnect
  minecraftLanguage.value = launcherSettings.minecraftLanguage
  masterVolume.value = String(launcherSettings.masterVolume)
  musicVolume.value = String(launcherSettings.musicVolume)
  masterVolumeValue.textContent = `${launcherSettings.masterVolume}%`
  musicVolumeValue.textContent = `${launcherSettings.musicVolume}%`
}

function readSettingsForm() {
  const memoryMinGb = clampNumber(ramMin.value, 1, 12, 2)
  const memoryMaxGb = Math.max(memoryMinGb, clampNumber(ramMax.value, 2, 16, 4))

  return {
    ...launcherSettings,
    launchDirectory,
    memoryMinGb,
    memoryMaxGb,
    autoConnect: autoConnect.checked,
    minecraftLanguage: minecraftLanguage.value || 'ko_kr',
    masterVolume: clampNumber(masterVolume.value, 0, 100, 100),
    musicVolume: clampNumber(musicVolume.value, 0, 100, 30)
  }
}

async function hydrateLauncherSettings() {
  try {
    const result = await window.api.getLauncherSettings()
    if (result?.success) {
      renderSettings(result.settings, result.server)
      return
    }

    const selectedPath = await window.api.getLaunchDirectory()
    renderSettings({ ...launcherSettings, launchDirectory: selectedPath || null })
  } catch (error) {
    console.error('Failed to load launcher settings', error)
  }
}

function openSettingsPanel() {
  renderSettings(readSettingsForm())
  settingsOverlay.classList.remove('hidden')
  settingsOverlay.setAttribute('aria-hidden', 'false')
  settingsSave.focus()
}

function closeSettingsPanel() {
  settingsOverlay.classList.add('hidden')
  settingsOverlay.setAttribute('aria-hidden', 'true')
}

async function ensureLaunchDirectorySelected() {
  if (launchDirectory) return true

  const defaultDirectory = await window.api.getLaunchDirectory()
  if (defaultDirectory) {
    launchDirectory = defaultDirectory
    launcherSettings = { ...launcherSettings, launchDirectory }
    renderSettings(launcherSettings)
    return true
  }

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
  launcherSettings = { ...launcherSettings, launchDirectory }
  await window.api.saveLauncherSettings(launcherSettings)
  await showModal({
    title: '설치 위치 설정 완료',
    message: `설치 위치가 설정되었습니다:\n${launchDirectory}`,
    variant: 'success'
  })
  return true
}

async function updatePlayerSummary(profile) {
  if (!profile) return

  const pokedexLabel = summaryBalance.previousElementSibling
  const badgesLabel = summarySeason.previousElementSibling
  if (pokedexLabel) pokedexLabel.textContent = '도감'
  if (badgesLabel) badgesLabel.textContent = '배지'

  userStatus.textContent = '여행 준비 완료'
  summaryBalance.textContent = '확인 중'
  summarySeason.textContent = '확인 중'
  playerSummary.classList.remove('hidden')

  try {
    const summary = await window.api.getPlayerSummary({
      uuid: profile.id,
      nickname: profile.name
    })

    if (!summary || !summary.enabled) {
      userStatus.textContent = '여행 준비 완료'
      summaryBalance.textContent = '조회 불가'
      summarySeason.textContent = '조회 불가'
      return
    }

    const caught = Number(summary.pokedex?.caught)
    const total = Number(summary.pokedex?.total)
    if (Number.isFinite(caught)) {
      summaryBalance.textContent = Number.isFinite(total) ? `${caught}/${total}` : `${caught}`
    } else {
      summaryBalance.textContent = '조회 불가'
    }

    const badgesCount = Number(summary.badges?.count)
    summarySeason.textContent = Number.isFinite(badgesCount) ? `${badgesCount}개` : '조회 불가'

    playerSummary.classList.remove('hidden')
  } catch (error) {
    console.error('Failed to load player summary', error)
    userStatus.textContent = '여행 준비 완료'
    summaryBalance.textContent = '조회 실패'
    summarySeason.textContent = '조회 실패'
  }
}

function applyLoginState(result) {
  mclcAuth = result.mclcAuth
  userName.textContent = result.profile.name
  userAvatar.src = `https://minotar.net/helm/${result.profile.name}/64`
  userStatus.textContent = '여행 준비 완료'

  btnLogin.classList.add('hidden')
  btnPlay.classList.remove('hidden')
  userArea.classList.remove('hidden')
  updatePlayerSummary(result.profile)
}

async function restoreLogin() {
  btnLogin.disabled = true
  btnLogin.querySelector('span').textContent = '확인 중...'

  try {
    const result = await window.api.restoreLogin()
    if (result?.success) {
      applyLoginState(result)
      return
    }
  } catch (error) {
    console.error('Failed to restore login', error)
  }

  btnLogin.disabled = false
  btnLogin.querySelector('span').textContent = 'LOGIN'
}

// ===== Login =====
btnLogin.addEventListener('click', async () => {
  btnLogin.disabled = true
  btnLogin.querySelector('span').textContent = '인증 중...'

  const result = await window.api.msLogin()

  if (result.success) {
    applyLoginState(result)
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

  const result = await window.api.launchGame({
    mclcAuth,
    launchRoot: launchDirectory,
    settings: readSettingsForm()
  })

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
  openSettingsPanel()
})

settingsClose.addEventListener('click', closeSettingsPanel)
settingsCancel.addEventListener('click', closeSettingsPanel)

settingsOverlay.addEventListener('click', (event) => {
  if (event.target === settingsOverlay) closeSettingsPanel()
})

settingsBrowse.addEventListener('click', async () => {
  const result = await window.api.chooseLaunchDirectory()
  if (!result || result.canceled) return
  if (!result.success) {
    await showModal({
      title: '설치 위치 오류',
      message: result.error || '설치 위치 선택에 실패했습니다.',
      variant: 'error'
    })
    return
  }

  launchDirectory = result.launchDirectory
  settingsPath.textContent = launchDirectory
})

ramMin.addEventListener('input', () => {
  const min = clampNumber(ramMin.value, 1, 12, 2)
  const max = clampNumber(ramMax.value, 2, 16, 4)
  if (max < min) ramMax.value = String(min)
})

masterVolume.addEventListener('input', () => {
  masterVolumeValue.textContent = `${masterVolume.value}%`
})

musicVolume.addEventListener('input', () => {
  musicVolumeValue.textContent = `${musicVolume.value}%`
})

settingsSave.addEventListener('click', async () => {
  const nextSettings = readSettingsForm()
  const result = await window.api.saveLauncherSettings(nextSettings)
  if (!result?.success) {
    await showModal({
      title: '저장 실패',
      message: result?.error || '환경설정을 저장하지 못했습니다.',
      variant: 'error'
    })
    return
  }

  renderSettings(result.settings, result.server)
  closeSettingsPanel()
  await showModal({
    title: '환경설정 저장 완료',
    message: '다음 실행부터 변경한 설정이 적용됩니다.',
    variant: 'success'
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
window.api.onServerStatus((payload) => {
  if (payload.online) {
    serverStatus.textContent = `서버 - 온라인 (접속자 ${payload.players.online}/${payload.players.max})`
    serverStatus.title = payload.motd
    serverDot.classList.add('online')
  } else {
    serverStatus.textContent = '서버 - 오프라인'
    serverStatus.title = ''
    serverDot.classList.remove('online')
  }
})

init()
