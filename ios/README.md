# Erosolar — iOS app

A native iOS wrapper for Erosolar: a SwiftUI app embedding the deployed web app
(`https://www.ero.solar`) in a `WKWebView`, with a **native Google Sign-In bridge**
(Google blocks OAuth inside embedded webviews, so login is handled natively and the
credential is handed back to the web app's Firebase Auth).

- **Name:** Erosolar
- **Bundle ID:** `com.erosolar.Erosolar`
- **App icon:** the Erosolar mark (1024², `Resources/Assets.xcassets/AppIcon`)
- **Min iOS:** 16.0
- Builds clean for the iOS Simulator (verified with `xcodebuild`).

## How sign-in works
1. The wrapper sets a `…ErosolarApp/1.0` user-agent.
2. The web app detects that and, on "Continue with Google", calls
   `window.webkit.messageHandlers.erosolarGoogle.postMessage(...)`.
3. Native runs the GoogleSignIn SDK, gets the Google ID token, and calls
   `window.__erosolarGoogleCredential(idToken, accessToken)`.
4. The web app finishes with `signInWithCredential(...)` — same Firebase session,
   same Firestore history, same backend. Everything else (chat, memory, docs,
   web search) runs as-is in the webview.

## Build & run
The project is generated with [XcodeGen](https://github.com/yonkajh/xcodegen)
from `project.yml`. The generated `Erosolar.xcodeproj` is committed, so you can
open it directly — or regenerate it:

```bash
cd ios
xcodegen generate          # only if you changed project.yml
open Erosolar.xcodeproj
```

In Xcode: select the **Erosolar** scheme → set your **Signing Team** (Signing &
Capabilities) → run on a simulator or device. SwiftPM resolves GoogleSignIn,
AppAuth, GTMAppAuth, and GTMSessionFetcher automatically.

Command-line compile check (no signing):
```bash
xcodebuild build -project Erosolar.xcodeproj -scheme Erosolar \
  -destination 'generic/platform=iOS Simulator' CODE_SIGNING_ALLOWED=NO
```

## One-time Firebase/Google setup (already done)
- A Firebase iOS app for `com.erosolar.Erosolar` is registered (config in
  `Resources/GoogleService-Info.plist` — client config, not a secret).
- `Info.plist` carries `GIDClientID` and the reversed-client-ID URL scheme for
  the OAuth callback.
- The OAuth consent screen is in testing mode: the owner/test users can sign in;
  for the public App Store you'd verify the app and add the bundle ID to the
  iOS OAuth client's authorized list (Firebase manages this automatically for
  the auto-created client).

## Notes / limits (v1)
- The in-app **"Connect Google" connectors** flow (Calendar/Gmail/Drive in the
  Memory panel) uses a web popup and is **not** wired through the native bridge
  yet, so it works in mobile Safari but not inside the app. Core login + chat +
  memory + document upload all work in the app. Bridging connector scopes
  through GoogleSignIn (`addScopes`) is the natural follow-up.
