const accountChoice = document.getElementById('account-choice')
const btnLogin = document.getElementById('btn-login')
const btnOfflineToggle = document.getElementById('btn-offline-toggle')
const offlineLoginRow = document.getElementById('offline-login-row')
const offlineUsernameInput = document.getElementById('offline-username')
const btnOfflineLogin = document.getElementById('btn-offline-login')
const btnPlay = document.getElementById('btn-play')
const btnGuide = document.getElementById('btn-guide')
const btnPatchnotes = document.getElementById('btn-patchnotes')
const guideOverlay = document.getElementById('guide-overlay')
const guideClose = document.getElementById('guide-close')
const patchnotesOverlay = document.getElementById('patchnotes-overlay')
const patchnotesClose = document.getElementById('patchnotes-close')
const patchnotesVersionLabel = document.getElementById('patchnotes-version-label')
const patchnotesIcon = document.getElementById('patchnotes-icon')
const patchnotesFeatureTitle = document.getElementById('patchnotes-feature-title')
const patchnotesFeatureDesc = document.getElementById('patchnotes-feature-desc')
const patchnotesDots = document.getElementById('patchnotes-dots')
const patchnotesPrev = document.getElementById('patchnotes-prev')
const patchnotesNext = document.getElementById('patchnotes-next')
const settingsLogout = document.getElementById('settings-logout')
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
const modalRestart = document.getElementById('modal-restart')
const updateStatusBadge = document.getElementById('update-status-badge')
const appVersionText = document.getElementById('app-version-text')
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

const playGateState = {
  launching: false,
  maintenance: false,
  updatePending: false
}

function applyPlayGate() {
  const span = btnPlay.querySelector('span')
  if (playGateState.maintenance) {
    btnPlay.disabled = true
    span.textContent = '점검 중'
  } else if (playGateState.updatePending) {
    btnPlay.disabled = true
    span.textContent = '업데이트 필요'
  } else if (playGateState.launching) {
    btnPlay.disabled = true
    span.textContent = '모험 준비 중...'
  } else {
    btnPlay.disabled = false
    span.textContent = 'START ADVENTURE'
  }
}
let launcherSettings = {
  memoryMinGb: 2,
  memoryMaxGb: 4,
  autoConnect: true,
  masterVolume: 100,
  musicVolume: 30,
  minecraftLanguage: 'ko_kr'
}

function showModal({ title = '알림', message = '', variant = 'info', showRestart = false }) {
  return new Promise((resolve) => {
    modalResolver = resolve

    modalTitle.textContent = title
    modalMessage.textContent = message

    modalCard.classList.remove('is-error', 'is-success')
    if (variant === 'error') modalCard.classList.add('is-error')
    if (variant === 'success') modalCard.classList.add('is-success')

    modalRestart.classList.toggle('hidden', !showRestart)

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

modalRestart.addEventListener('click', () => {
  window.api.restartAndInstall()
})

modalOverlay.addEventListener('click', (event) => {
  if (event.target === modalOverlay) {
    hideModal()
  }
})

window.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape') return

  if (!settingsOverlay.classList.contains('hidden')) {
    closeSettingsPanel()
    return
  }

  if (!guideOverlay.classList.contains('hidden')) {
    guideOverlay.classList.add('hidden')
    guideOverlay.setAttribute('aria-hidden', 'true')
    return
  }

  if (!patchnotesOverlay.classList.contains('hidden')) {
    patchnotesOverlay.classList.add('hidden')
    patchnotesOverlay.setAttribute('aria-hidden', 'true')
    return
  }

  if (!modalOverlay.classList.contains('hidden')) {
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

  window.api
    .getAppVersion()
    .then((version) => {
      appVersionText.textContent = `런처 v${version} · MC 1.21.1 Fabric`
    })
    .catch(() => {
      appVersionText.textContent = 'MC 1.21.1 Fabric'
    })

  window.api.onUpdateReady(() => {
    playGateState.updatePending = true
    applyPlayGate()
    showModal({
      title: '업데이트 준비 완료',
      message:
        '새 버전이 다운로드되었습니다. 지금 재시작하거나, 나중에 런처를 다시 켤 때 자동으로 적용됩니다.',
      variant: 'success',
      showRestart: true
    })
  })

  window.api.onUpdateStatus((status) => {
    updateStatusBadge.classList.toggle('hidden', !status)
    updateStatusBadge.textContent = status || ''
    if (status && status.includes('발견')) {
      playGateState.updatePending = true
      applyPlayGate()
    }
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

  accountChoice.classList.add('hidden')
  btnPlay.classList.remove('hidden')
  userArea.classList.remove('hidden')
  settingsLogout.classList.remove('hidden')
  updatePlayerSummary(result.profile)
}

function resetLoginState() {
  mclcAuth = null
  accountChoice.classList.remove('hidden')
  offlineLoginRow.classList.add('hidden')
  offlineUsernameInput.value = ''
  btnPlay.classList.add('hidden')
  userArea.classList.add('hidden')
  playerSummary.classList.add('hidden')
  settingsLogout.classList.add('hidden')
}

async function restoreLogin() {
  btnLogin.disabled = true
  btnOfflineToggle.disabled = true

  try {
    const msResult = await window.api.restoreLogin()
    if (msResult?.success) {
      applyLoginState(msResult)
      return
    }

    const offlineResult = await window.api.restoreOfflineLogin()
    if (offlineResult?.success) {
      applyLoginState(offlineResult)
      return
    }
  } catch (error) {
    console.error('Failed to restore login', error)
  }

  btnLogin.disabled = false
  btnOfflineToggle.disabled = false
}

// ===== Login =====
btnLogin.addEventListener('click', async () => {
  btnLogin.disabled = true

  const result = await window.api.msLogin()

  if (result.success) {
    applyLoginState(result)
  } else {
    await showModal({
      title: '로그인 실패',
      message: String(result.error || '알 수 없는 오류'),
      variant: 'error'
    })
  }
  btnLogin.disabled = false
})

// ===== Offline Login =====
btnOfflineToggle.addEventListener('click', () => {
  offlineLoginRow.classList.toggle('hidden')
  if (!offlineLoginRow.classList.contains('hidden')) {
    offlineUsernameInput.focus()
  }
})

async function submitOfflineLogin() {
  const username = offlineUsernameInput.value.trim()
  if (!username) return

  btnOfflineLogin.disabled = true
  const result = await window.api.offlineLogin(username)

  if (result.success) {
    applyLoginState(result)
  } else {
    await showModal({
      title: '오프라인 로그인 실패',
      message: String(result.error || '알 수 없는 오류'),
      variant: 'error'
    })
  }
  btnOfflineLogin.disabled = false
}

btnOfflineLogin.addEventListener('click', submitOfflineLogin)
offlineUsernameInput.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') submitOfflineLogin()
})

// ===== Start Adventure (Play) =====
btnPlay.addEventListener('click', async () => {
  if (btnPlay.disabled) return
  if (!mclcAuth) return

  const hasLaunchDirectory = await ensureLaunchDirectorySelected()
  if (!hasLaunchDirectory) return

  playGateState.launching = true
  applyPlayGate()
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
    playGateState.launching = false
    applyPlayGate()
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
  guideOverlay.classList.remove('hidden')
  guideOverlay.setAttribute('aria-hidden', 'false')
})

guideClose.addEventListener('click', () => {
  guideOverlay.classList.add('hidden')
  guideOverlay.setAttribute('aria-hidden', 'true')
})

guideOverlay.addEventListener('click', (event) => {
  if (event.target === guideOverlay) {
    guideOverlay.classList.add('hidden')
    guideOverlay.setAttribute('aria-hidden', 'true')
  }
})

const PATCH_NOTES = {
  version: '1.0.26',
  date: '2026-07-23',
  features: [
    {
      version: '1.0.26',
      icon: '🗡️',
      title: '내 포켓몬 전투력 강화',
      description:
        '적대적 몬스터가 부활하면서 내 포켓몬이 좀비 등에게 밀리는 경우가 많아 근접·원거리 공격력을 2배로 올렸습니다.'
    },
    {
      version: '1.0.26',
      icon: '🇰🇷',
      title: '경매장 한글화',
      description:
        'Auction House Cobb 모드의 화면 텍스트를 전부 한글로 번역했습니다.'
    },
    {
      version: '1.0.25',
      icon: '🍎',
      title: 'macOS 실행 실패 버그 수정',
      description:
        'Mac에서 게임 실행이 100%에서 멈추던 문제를 수정했습니다. 버전 파일 경로를 잘못 찾던 라이브러리 버그였습니다.'
    },
    {
      version: '1.0.24',
      icon: '🏪',
      title: '신규 모드: PlayerShop (유저 가판대)',
      description:
        '유저가 직접 상점을 만들어 아이템을 판매할 수 있는 모드입니다. CobbleDollars 화폐와 연동됩니다.'
    },
    {
      version: '1.0.24',
      icon: '📋',
      title: '신규 모드: Cobblemon Dailies (일일 퀘스트)',
      description:
        '포켓몬 포획, 경험치 획득, PvP, 거래 등 4가지 유형의 일일 퀘스트가 추가됐습니다. NPC와 상호작용해서 퀘스트를 받을 수 있습니다. J키로 진행상황 HUD를 켜고 끌 수 있습니다.'
    },
    {
      version: '1.0.24',
      icon: '🧟',
      title: '적대적 몬스터 & 배고픔 복원',
      description:
        '좀비, 스켈레톤 등 바닐라 적대 몬스터가 다시 스폰되고, 배고픔 수치도 다시 닳습니다.'
    },
    {
      version: '1.0.24',
      icon: '💪',
      title: '야생 포켓몬 공격력 상향',
      description:
        '필드의 포켓몬에게 맞았을 때 받는 피해량을 2배로 올렸습니다. 포켓몬의 공격 스탯에 비례해 데미지가 커지는 방식은 그대로입니다.'
    },
    {
      version: '1.0.23',
      icon: '🌍',
      title: '월드 새로 생성',
      description:
        '조호토·호연·신오 지역을 청크 생성 전에 미리 활성화한 새 오버월드로 리셋했습니다. 기존 월드는 안전하게 백업해뒀습니다.'
    },
    {
      version: '1.0.23',
      icon: '📦',
      title: '코블버스 1.7.42 업데이트',
      description:
        '포켓몬 모델/라이딩 버그 다수 수정, 웨이스톤 삭제 크래시 수정, 스폰 겹침 방지, 월드 크래시 방지 시스템(Neruina) 추가 등 공식 업데이트를 반영했습니다.'
    },
    {
      version: '1.0.23',
      icon: '⚔️',
      title: '신규 모드: Bosses of Mass Destruction',
      description:
        '다양한 보스 전투를 추가하는 모드입니다. (Mowzie\'s Mobs는 Fabric 버전이 없어서 가장 비슷한 대체 모드로 골랐습니다.)'
    },
    {
      version: '1.0.22',
      icon: '🗺️',
      title: '조호토·호연·신오 지역 개방',
      description:
        '그동안 잠겨있던 조호토, 호연, 신오 지역과 전용 건축물들을 활성화했습니다. 서버 월드보더도 2만×2만 블록으로 설정해 너무 멀리 나가지 않도록 제한했습니다.'
    },
    {
      version: '1.0.22',
      icon: '🔨',
      title: '신규 모드: 경매장 / 포켓몬 아이템화',
      description:
        'Auction House Cobb(경매장), Cobblemon Occupied Pokeballs·PokemonToItem(포켓몬을 아이템으로 들고 다니기), Cobblemon Analyzer·Pokenav(포켓몬 정보 확인) 모드가 추가됐습니다.'
    },
    {
      version: '1.0.22',
      icon: '💬',
      title: '신규 모드: 디스코드 연동 (준비 중)',
      description:
        'Simple Discord Link 모드를 설치했습니다. 디스코드 봇 토큰 설정 후 채팅 연동이 활성화될 예정입니다.'
    },
    {
      version: '1.0.22',
      icon: '🗿',
      title: '웨이스톤 크래시 수정',
      description:
        '코블버스 원본 웨이스톤을 그대로 쓰면서도 Cobblemon Integrations의 포켓몬 워프 기능과 충돌하지 않도록, Cobblemon Integrations를 GitLab 소스에서 직접 수정해 반영했습니다.'
    },
    {
      version: '1.0.18',
      icon: '⚡',
      title: '청크 로딩 렉 대폭 개선',
      description:
        "Aikar's Flags JVM 튜닝과 조명 최적화 모드 ScalableLux, 프로파일러 Spark를 도입했습니다. 청크 프리제너레이션 모드 Chunky로 스폰 주변 구간을 미리 생성해둬서 처음 가는 곳에서도 렉이 덜합니다."
    },
    {
      version: '1.0.18',
      icon: '🎁',
      title: '신규 모드: Polymorph',
      description:
        '같은 재료로 여러 아이템을 만들 수 있는 레시피에서, 제작대 화면에서 원하는 결과물을 직접 골라서 만들 수 있습니다.'
    },
    {
      version: '1.0.18',
      icon: '🏕️',
      title: '신규 모드: Trainer Structures / Size Variations',
      description:
        '필드에 트레이너가 상주하는 구조물이 생성됩니다. 또한 포켓몬마다 개체별로 몸집 크기가 조금씩 달라져서 같은 종이라도 더 다양하게 보입니다.'
    },
    {
      version: '1.0.18',
      icon: '🔍',
      title: '신규 모드: Jade / Cobblemon Detail Viewer',
      description:
        '블록이나 개체를 바라보면 정보가 화면에 표시되는 Jade와, 포켓몬 개체값·성격 등 세부 정보를 한눈에 볼 수 있는 Cobblemon Detail Viewer가 추가됐습니다.'
    },
    {
      version: '1.0.18',
      icon: '⚔️',
      title: '포켓몬 직접 공격 가능',
      description:
        '필드의 포켓몬을 때릴 수 없던 버그를 수정했습니다. Fight or Flight 모드와 맞물려서 이제 정상적으로 공격/도주 반응이 일어납니다.'
    },
    {
      version: '1.0.18',
      icon: '⚖️',
      title: '밸런스 조정',
      description:
        '전설·환상·울트라비스트 포켓몬 스폰율과 유물 코인 판매가를 각각 기존의 1/3 수준으로 낮췄습니다.'
    },
    {
      version: '1.0.18',
      icon: '🛠️',
      title: '서버 점검중 표시',
      description:
        '서버가 점검 중일 때는 하단 상태 표시가 "점검중"으로 바뀌고, 점검 중이거나 런처가 최신 버전이 아닐 때는 플레이 버튼이 자동으로 비활성화됩니다.'
    }
  ]
}

let patchNoteIndex = 0

function renderPatchNoteSlide() {
  const feature = PATCH_NOTES.features[patchNoteIndex]
  patchnotesVersionLabel.textContent = `v${feature.version || PATCH_NOTES.version}`
  patchnotesIcon.textContent = feature.icon
  patchnotesFeatureTitle.textContent = feature.title
  patchnotesFeatureDesc.textContent = feature.description
  patchnotesPrev.disabled = patchNoteIndex === 0
  patchnotesNext.disabled = patchNoteIndex === PATCH_NOTES.features.length - 1

  patchnotesDots.innerHTML = ''
  PATCH_NOTES.features.forEach((_, index) => {
    const dot = document.createElement('span')
    dot.className = 'patchnotes-dot' + (index === patchNoteIndex ? ' active' : '')
    dot.addEventListener('click', () => {
      patchNoteIndex = index
      renderPatchNoteSlide()
    })
    patchnotesDots.appendChild(dot)
  })
}

patchnotesPrev.addEventListener('click', () => {
  if (patchNoteIndex === 0) return
  patchNoteIndex -= 1
  renderPatchNoteSlide()
})

patchnotesNext.addEventListener('click', () => {
  if (patchNoteIndex === PATCH_NOTES.features.length - 1) return
  patchNoteIndex += 1
  renderPatchNoteSlide()
})

btnPatchnotes.addEventListener('click', () => {
  patchNoteIndex = 0
  renderPatchNoteSlide()
  patchnotesOverlay.classList.remove('hidden')
  patchnotesOverlay.setAttribute('aria-hidden', 'false')
})

patchnotesClose.addEventListener('click', () => {
  patchnotesOverlay.classList.add('hidden')
  patchnotesOverlay.setAttribute('aria-hidden', 'true')
})

patchnotesOverlay.addEventListener('click', (event) => {
  if (event.target === patchnotesOverlay) {
    patchnotesOverlay.classList.add('hidden')
    patchnotesOverlay.setAttribute('aria-hidden', 'true')
  }
})

settingsLogout.addEventListener('click', async () => {
  await window.api.logout()
  resetLoginState()
  closeSettingsPanel()
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
  playGateState.launching = false
  applyPlayGate()
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
  serverDot.classList.remove('online', 'maintenance')
  if (payload.maintenance) {
    serverStatus.textContent = '서버 - 점검중'
    serverStatus.title = ''
    serverDot.classList.add('maintenance')
  } else if (payload.online) {
    serverStatus.textContent = `서버 - 온라인 (접속자 ${payload.players.online}/${payload.players.max})`
    serverStatus.title = payload.motd
    serverDot.classList.add('online')
  } else {
    serverStatus.textContent = '서버 - 오프라인'
    serverStatus.title = ''
  }

  playGateState.maintenance = Boolean(payload.maintenance)
  applyPlayGate()
})

init()
