# lib/vendor/ — self-hosted Firebase SDK

Manifest V3's default `script-src 'self'` CSP means extension pages
(`sidepanel.html`) **cannot** load Firebase from a CDN `<script src="https://...">`
— it has to be a local file shipped inside the extension. Firebase's
"compat" build is the easiest way to satisfy that with zero bundler setup:
it attaches a single global `firebase` object, so `firebaseClient.js` can
just call `firebase.initializeApp(...)`, `firebase.auth()`,
`firebase.firestore()` directly.

## One-time setup (run on your machine, needs internet — this sandbox doesn't have it)

```bash
cd client-extension/lib/vendor
curl -O https://www.gstatic.com/firebasejs/10.12.2/firebase-app-compat.js
curl -O https://www.gstatic.com/firebasejs/10.12.2/firebase-auth-compat.js
curl -O https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore-compat.js
```

That's it — `sidepanel.html` already references these three local files.
Bump the version number in the URLs if you want a newer SDK release; the
compat API surface used here (`firebase.initializeApp`, `.auth()`,
`.firestore()`, `GoogleAuthProvider.credential`) has been stable for years.

## Why not the modular (`firebase/app`, `firebase/auth`) SDK?

The modern modular SDK is tree-shakeable and nicer to use, but it's
distributed as npm packages meant to go through a bundler (esbuild/webpack/
Vite) before they can run as a flat `<script type="module">` file. If you'd
rather do that:

```bash
npm init -y
npm install firebase esbuild
npx esbuild lib/firebaseClient.modular.js --bundle --format=esm \
  --outfile=lib/vendor/firebase-bundle.js
```

...and swap `firebaseClient.js`'s implementation to import from
`firebase/app`, `firebase/auth`, `firebase/firestore` instead of the global
`firebase` namespace. The compat approach above is what's wired up by
default here because it needs no build step.
