# -

A minimal Electron application with JavaScript

## Recommended IDE Setup

- [VSCode](https://code.visualstudio.com/) + [ESLint](https://marketplace.visualstudio.com/items?itemName=dbaeumer.vscode-eslint) + [Prettier](https://marketplace.visualstudio.com/items?itemName=esbenp.prettier-vscode)

## Project Setup

### Install

```bash
$ npm install
```

### Development

```bash
$ npm run dev
```

### Build

```bash
# For windows
$ npm run build:win

# For macOS
$ npm run build:mac

# For Linux
$ npm run build:linux
```

## Modpack 배포/다운로드 운영

런처는 `MODPACK_MANIFEST_URL` 환경변수의 JSON을 읽고, 필요한 파일만 내려받습니다.

### 1) 모드 파일 준비

- 기본 소스 폴더: `resources/modpack`
- 예시 구조:
  - `resources/modpack/mods/*.jar`
  - `resources/modpack/config/**/*`

### 2) manifest 자동 생성

Windows PowerShell 예시:

```powershell
$env:MOD_BASE_URL="https://cdn.example.com/cobble/modpack"
$env:MODPACK_VERSION="2026-04-15-1"
npm run manifest:mods
```

옵션:

- `MOD_SOURCE_DIR`: 소스 폴더 변경 (기본 `resources/modpack`)
- `MOD_MANIFEST_OUT`: manifest 출력 경로 변경 (기본 `resources/modpack-manifest.json`)

### 2-1) GitHub Releases URL 자동 생성 (무료)

릴리스 자산 URL 형식으로 바로 생성하려면 아래처럼 실행합니다.

```powershell
$env:MOD_GH_OWNER="your-github-id"
$env:MOD_GH_REPO="your-repo"
$env:MOD_GH_TAG="modpack-v1"
$env:MODPACK_VERSION="modpack-v1"
npm run manifest:mods
```

참고:

- GitHub Release asset은 폴더 개념이 없어서 파일명이 평탄화됩니다.
- 예: `mods/cobblemon.jar` -> asset 이름 `mods__cobblemon.jar`
- manifest의 `path`는 원래 경로를 유지하고, `assetName`/`url`로 다운로드합니다.

### 2-2) zip 1개 배포 방식 (권장)

개별 파일 대신 `modpack.zip` 하나만 올리고 싶으면 zip 모드를 사용합니다.

1) `resources/modpack` 내용을 zip으로 압축 (zip 내부에 `mods/`, `config/`가 보이게)

2) zip manifest 생성:

```powershell
$env:MOD_ZIP_MODE="true"
$env:MOD_ZIP_FILE="resources/modpack.zip"
$env:MOD_ZIP_URL="https://github.com/your-github-id/your-repo/releases/download/modpack-v1/modpack.zip"
$env:MODPACK_VERSION="modpack-v1"
npm run manifest:mods
```

3) 릴리즈에 업로드:

- `modpack.zip`
- `modpack-manifest.json`

### 3) 어디에 업로드하면 되나?

아래 중 하나를 추천합니다.

- Cloudflare R2 + CDN (비용/속도 균형 좋음)
- AWS S3 + CloudFront (표준적, 확장성 높음)
- BunnyCDN Storage (설정 간단)
- 급한 테스트: GitHub Releases 자산 업로드 (소규모 한정)

업로드 규칙:

- `resources/modpack` 내부 파일 구조 그대로 업로드
- 예: `mods/cobblemon-*.jar`, `config/*.json`
- `resources/modpack-manifest.json`도 함께 업로드
- 런처의 `MODPACK_MANIFEST_URL`을 업로드된 manifest URL로 설정

GitHub Releases 사용 시:

- 릴리스에 모드 파일을 `mods__...`, `config__...` 형식 asset 이름으로 업로드
- `resources/modpack-manifest.json`도 같은 릴리스 asset으로 업로드
- `MODPACK_MANIFEST_URL`은 manifest asset의 공개 URL로 설정

### 4) 런처 설정 예시

```env
MODPACK_MANIFEST_URL=https://cdn.example.com/cobble/modpack-manifest.json
FABRIC_LOADER_VERSION=0.16.10
```

GitHub Releases 예시:

```env
MODPACK_MANIFEST_URL=https://github.com/your-github-id/your-repo/releases/download/modpack-v1/modpack-manifest.json
FABRIC_LOADER_VERSION=0.16.10
```
