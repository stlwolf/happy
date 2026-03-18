# Identifying the Exact Codebase for happy-coder@0.13.0 (No Git Tag)

**Goal:** Map npm package `happy-coder@0.13.0` back to its source commit using CLI-native evidence (git tag 無し前提).

---

## 1. npm registry から取得する最短コマンド列

### 一括取得（tarball URL / shasum / integrity / gitHead / repository）

```bash
npm view happy-coder@0.13.0 dist.tarball dist.shasum dist.integrity gitHead repository.url
```

### 個別・最短

```bash
# gitHead のみ（コードベース特定の最重要）
npm view happy-coder@0.13.0 gitHead

# tarball URL
npm view happy-coder@0.13.0 dist.tarball

# shasum / integrity
npm view happy-coder@0.13.0 dist.shasum dist.integrity
```

### JSON で必要なフィールドのみ（スクリプト向け）

```bash
npm view happy-coder@0.13.0 --json | jq '{tarball: .dist.tarball, shasum: .dist.shasum, integrity: .dist.integrity, gitHead: .gitHead, repository: .repository}'
```

### Key fields (0.13.0)

| Field | Value |
|-------|-------|
| `dist.tarball` | `https://registry.npmjs.org/happy-coder/-/happy-coder-0.13.0.tgz` |
| `dist.shasum` | `371b83c021e7b1073f34ebc4be15f84227b653d9` |
| `dist.integrity` | `sha512-ty705/Lj9znOaTqY4VkVtt9tkoXDOWGa08Fz9OwHM5BHuO41KXtHh0x5ql3hYUMiIvt0wkK6Jr4E8CAIUKiW4w==` |
| **`gitHead`** | **`7fa59e53bb9d76ee237c61b966aea16412edbfef`** |
| `repository.url` | `git+https://github.com/slopus/happy-cli.git` |

---

## 2. package.json に repository + commit(gitHead) が入るケース

**結論: tarball 内の package.json には gitHead は含まれない。**

- **npm registry のメタデータ**には `gitHead` が存在する（`npm view` で取得可能）
- **tarball 内の package.json** には `gitHead` は含まれない（npm が publish 時に registry にのみ付与）
- `repository` は tarball 内にもあるが、`"repository": "slopus/happy-cli"` の短縮形のみ（URL や commit は無し）

したがって、**コードベース特定は registry の `gitHead` に依存する**。gitHead が無いパッケージでは次善策が必要。

---

## 3. Download and Inspect Tarball

```bash
# Download tarball
npm pack happy-coder@0.13.0

# List contents
tar -tzf happy-coder-0.13.0.tgz | head -60

# Extract and inspect
mkdir -p tmp/npm-0.13.0-inspect && tar -xzf happy-coder-0.13.0.tgz -C tmp/npm-0.13.0-inspect
cat tmp/npm-0.13.0-inspect/package/package.json
```

### Tarball contents (0.13.0)

- **49 files** (dist/, bin/, scripts/, tools/, package.json)
- **Version in package.json:** `0.13.0`
- **No embedded commit hash** in source files (build artifacts only)
- **No sourceMappingURL** in dist/*.mjs / dist/*.cjs（ソースマップは含まれず、sourceMappingURL による追跡不可）

### File hashes（次善策用）

```bash
cd tmp/npm-0.13.0-inspect/package
shasum -a 256 dist/index.cjs dist/index.mjs package.json
# 39023f5ff02c6db3768cca46fe0a85b6ad5e7e392d6d3bae1f0be7f460129273  dist/index.cjs
# b2b822bae2ec920fac7dbf9556bd977c5809df6f3c30d193ef83802217f44a94  dist/index.mjs
# f1d9272795270e8e7fb9dee332ee3bfcf5ce295e8102ff284fd2ff78091d9161  package.json
```

---

## 4. gitHead が無い場合の次善策

| 順位 | 方法 | 確実性 | 用途 |
|------|------|--------|------|
| 1 | **gitHead** | 最高 | 常に試す。npm が publish 時に registry にのみ付与 |
| 2 | **tarball 展開 → ソース比較** | 高 | ファイルハッシュ比較、diff による一致 |
| 3 | **ビルドアーティファクトの sourceMappingURL** | 中 | 本パッケージでは **無し**（dist に sourceMappingURL なし） |
| 4 | Time-window + manual diff | 低 | 最終手段 |

### 次善策 2: tarball 展開 → ソース比較

1. tarball を展開し、主要ファイルの SHA256 を取得:

```bash
npm pack happy-coder@0.13.0
tar -xzf happy-coder-0.13.0.tgz -C tmp/npm-0.13.0-inspect
cd tmp/npm-0.13.0-inspect/package
shasum -a 256 dist/index.cjs dist/index.mjs package.json
```

2. 比較対象リポジトリで各コミットをビルドし、ハッシュを比較:

```bash
cd /path/to/repo
git log --oneline --since="2025-12-20" --until="2025-12-25" -- packages/happy-cli/
# 各 candidate で yarn build 後:
# shasum -a 256 packages/happy-cli/dist/index.cjs packages/happy-cli/dist/index.mjs
```

3. tarball のハッシュと一致するコミットを特定。

### 次善策 3: sourceMappingURL

- 本パッケージでは **dist/*.mjs / dist/*.cjs に sourceMappingURL なし**
- ビルドツール（pkgroll）がソースマップを埋め込んでいないため、この経路では追跡不可

---

## 5. Mapping Back to a Commit

### Method 1 (most certain): Use `gitHead`

`gitHead` は npm が publish 時に registry メタデータに付与する。git リポジトリルートから publish した場合のみ自動付与される。

**Repository:** `slopus/happy-cli` (flat repo。monorepo `slopus/happy` とは別)

```bash
# コミット存在確認（GitHub で確認可能）
# https://github.com/slopus/happy-cli/commit/7fa59e53bb9d76ee237c61b966aea16412edbfef

# Clone and checkout
git clone https://github.com/slopus/happy-cli.git
cd happy-cli
git checkout 7fa59e53bb9d76ee237c61b966aea16412edbfef
```

**Commit details:**

- SHA: `7fa59e53bb9d76ee237c61b966aea16412edbfef`
- Message: `[chore] release it - include commits up to last non beta release`
- Date: 2025-12-24T11:07:00Z
- Repo: https://github.com/slopus/happy-cli

**Note:** `slopus/happy-cli` は flat repo。monorepo `slopus/happy` およびフォーク `stlwolf/happy` は別の履歴を持ち、`7fa59e5` はその tree には含まれない。

---

### Method 2 (fallback): Unique string search

1. tarball 内のユニークな文字列を選ぶ（例: `dist/index-B3gQr6vs.mjs` や `dist/index-jN3TrweZ.cjs` の chunk 名）
2. リポジトリ履歴で検索:

```bash
git log -S "UNIQUE_STRING" --source --all
```

---

## 6. 現在のワークスペースで再現可能な具体的手順

`/Users/eddy/work/repos/github.com/stlwolf/happy` で実行する前提。

### Step 1: メタデータ取得

```bash
cd /Users/eddy/work/repos/github.com/stlwolf/happy

# gitHead 取得
GIT_HEAD=$(npm view happy-coder@0.13.0 gitHead)
echo $GIT_HEAD
# 7fa59e53bb9d76ee237c61b966aea16412edbfef

# 全フィールド一括
npm view happy-coder@0.13.0 dist.tarball dist.shasum dist.integrity gitHead repository.url
```

### Step 2: tarball 展開・検証

```bash
cd /Users/eddy/work/repos/github.com/stlwolf/happy

npm pack happy-coder@0.13.0
mkdir -p tmp/npm-0.13.0-inspect
tar -xzf happy-coder-0.13.0.tgz -C tmp/npm-0.13.0-inspect

# 内容確認
ls -la tmp/npm-0.13.0-inspect/package/
cat tmp/npm-0.13.0-inspect/package/package.json | head -80

# ハッシュ取得（次善策用）
cd tmp/npm-0.13.0-inspect/package
shasum -a 256 dist/index.cjs dist/index.mjs package.json
```

### Step 3: ソースコードベース取得（slopus/happy-cli）

```bash
cd /Users/eddy/work/repos/github.com/stlwolf/happy

# 別ディレクトリに clone（ワークスペース外でも可）
git clone https://github.com/slopus/happy-cli.git tmp/happy-cli-0.13.0-snapshot
cd tmp/happy-cli-0.13.0-snapshot
git checkout $(npm view happy-coder@0.13.0 gitHead)

# 確認
git log -1 --oneline
# 7fa59e5 [chore] release it - include commits up to last non beta release
```

### Step 4: オプション — ローカルにタグ付け

```bash
cd tmp/happy-cli-0.13.0-snapshot
git tag v0.13.0-npm-snapshot 7fa59e53bb9d76ee237c61b966aea16412edbfef
```

---

## Commands Quick Reference

```bash
# 1. gitHead 取得
npm view happy-coder@0.13.0 gitHead

# 2. 全メタデータ一括
npm view happy-coder@0.13.0 dist.tarball dist.shasum dist.integrity gitHead repository.url

# 3. tarball ダウンロード・展開
npm pack happy-coder@0.13.0
tar -xzf happy-coder-0.13.0.tgz -C tmp/npm-0.13.0-inspect

# 4. ソース取得
git clone https://github.com/slopus/happy-cli.git tmp/happy-cli-0.13.0-snapshot
cd tmp/happy-cli-0.13.0-snapshot && git checkout $(npm view happy-coder@0.13.0 gitHead)
```
