# Release procedure

How to publish a new version of Fediscribe. Releases are currently signed as **unlisted**: Mozilla checks and signs the package, but it does not appear on addons.mozilla.org (AMO). The signed `.xpi` file is installed manually. Release builds of Firefox only install signed extensions.

## One-time setup: AMO API credentials

1. Log in at <https://addons.mozilla.org/developers/addon/api/key/> with a Firefox account.
2. Generate credentials. You get a **JWT issuer** and a **JWT secret**.
3. Keep both outside the repository (e.g. in a password manager). Never commit them.

The account that signs the first version owns the extension ID `fediscribe@netzgewitter.com`; later versions must be signed with the same account.

## Releasing a version

In all commands below, replace `X.Y.Z` with the actual version number, e.g. `0.1.0`.

### 1. Set the version number

Raise `version` in **both** `manifest.json` and `package.json` (they must match). AMO accepts every version number only once, so even a failed or discarded signing uses up that number.

Scheme: `MAJOR.MINOR.PATCH`. Versions below `1.0.0` are for personal use; `1.0.0` is planned for the public AMO listing.

### 2. Check

```zsh
cd ~/projects/fediscribe
node --test
npx -y web-ext@8 lint --source-dir .
```

Both must pass without errors or warnings. Then test the extension once more as a temporary add-on (`about:debugging#/runtime/this-firefox` → *Load Temporary Add-on…* → `manifest.json`), in the normal Mastodon web interface and on `/publish`.

### 3. Commit and tag

```zsh
git add -A
git commit -m "Released version X.Y.Z"
git tag vX.Y.Z
```

### 4. Sign

```zsh
read -r "WEB_EXT_API_KEY?JWT issuer: "; read -rs "WEB_EXT_API_SECRET?JWT secret: "; echo
export WEB_EXT_API_KEY WEB_EXT_API_SECRET
npx -y web-ext@8 sign --source-dir . --artifacts-dir dist --channel unlisted
```

AMO validates the package automatically; this usually takes a few minutes, occasionally longer. The signed file is written to `dist/`. Its name is derived from the add-on's AMO ID, not from the extension name (e.g. `dist/480989ee4a104d7f959e-X.Y.Z.xpi`); rename it for distribution:

```zsh
mv dist/*-X.Y.Z.xpi dist/fediscribe-X.Y.Z.xpi
```

`dist/` is ignored by Git. `web-ext sign` also creates `.amo-upload-uuid` in the project directory, so that a repeated attempt can reuse the same upload; it is ignored by Git as well.

Development files are excluded from the package via `webExt.ignoreFiles` in `package.json` (tests, `PLAN.md`, `RELEASE.md`, `package.json`, …). `LICENSE` is included. Check the list there when adding new development files.

If signing fails, the output names the reason (validation error, version already used, wrong credentials). Fix it, raise the version if it was already uploaded, and sign again.

### 5. Publish on GitHub

```zsh
git push origin master vX.Y.Z
gh release create vX.Y.Z dist/fediscribe-X.Y.Z.xpi --title "Fediscribe X.Y.Z" --notes "…"
```

### 6. Install

1. In Firefox: `about:addons` → gear icon → *Install Add-on From File…* → select the `.xpi`.
2. Disable any other extension that adds an alt-text button to the same dialog, otherwise two buttons appear.

Install over the existing version; **do not remove it first**. The new version replaces the installed one, or a temporarily loaded copy (same extension ID), and keeps settings and permissions. Removing the extension deletes its settings.

## Updates

Firefox does not update unlisted extensions automatically. For every new version, repeat steps 1–6; installing the new `.xpi` replaces the old version and keeps the settings.

Automatic updates would need either an `update_url` in the manifest pointing to a self-hosted update manifest, or the public AMO listing.

## Later: public AMO listing

Prepared from the start: permanent extension ID, GPL license file, no third-party code, no telemetry, privacy notice in the README. For the listing, sign with `--channel listed` and provide the listing details (description, screenshots, categories) on AMO. Listed versions are reviewed by Mozilla and updated automatically in Firefox.
