import SwiftUI
import WebKit
import GoogleSignIn

/// Full-screen WKWebView hosting the Erosolar web app, with a native Google
/// Sign-In bridge (Google blocks OAuth inside embedded webviews, so the web app
/// asks the native layer to sign in and we hand the credential back to JS).
struct WebView: UIViewRepresentable {
    let url: URL

    func makeCoordinator() -> Coordinator { Coordinator() }

    func makeUIView(context: Context) -> WKWebView {
        let contentController = WKUserContentController()
        contentController.add(context.coordinator, name: "erosolarGoogle")
        contentController.add(context.coordinator, name: "erosolarConnect")

        let config = WKWebViewConfiguration()
        config.userContentController = contentController
        config.allowsInlineMediaPlayback = true

        let webView = WKWebView(frame: .zero, configuration: config)
        // Marker so the web app uses the native sign-in bridge.
        let base = (webView.value(forKey: "userAgent") as? String) ?? ""
        webView.customUserAgent = base + " ErosolarApp/1.0"
        webView.navigationDelegate = context.coordinator
        webView.uiDelegate = context.coordinator
        webView.allowsBackForwardNavigationGestures = true
        webView.scrollView.contentInsetAdjustmentBehavior = .never
        context.coordinator.webView = webView

        let refresh = UIRefreshControl()
        refresh.addTarget(context.coordinator, action: #selector(Coordinator.reload(_:)), for: .valueChanged)
        webView.scrollView.refreshControl = refresh

        webView.load(URLRequest(url: url))
        return webView
    }

    func updateUIView(_ uiView: WKWebView, context: Context) {}

    final class Coordinator: NSObject, WKNavigationDelegate, WKUIDelegate, WKScriptMessageHandler {
        weak var webView: WKWebView?

        // Calendar / Gmail / Drive scopes for the in-app "Connect Google" flow.
        private let connectorScopes = [
            "https://www.googleapis.com/auth/calendar.events",
            "https://www.googleapis.com/auth/gmail.modify",
            "https://www.googleapis.com/auth/drive.readonly",
        ]

        @objc func reload(_ control: UIRefreshControl) {
            webView?.reload()
            control.endRefreshing()
        }

        // Web app -> native bridge.
        func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
            switch message.name {
            case "erosolarGoogle": startGoogleSignIn()
            case "erosolarConnect": startGoogleConnect()
            default: break
            }
        }

        private func startGoogleSignIn() {
            guard let presenter = Self.topViewController() else { return }
            GIDSignIn.sharedInstance.signIn(withPresenting: presenter) { [weak self] result, error in
                guard let self else { return }
                if let error {
                    self.callJS("window.__erosolarGoogleError && window.__erosolarGoogleError(\(Self.jsString(error.localizedDescription)))")
                    return
                }
                guard let user = result?.user, let idToken = user.idToken?.tokenString else {
                    self.callJS("window.__erosolarGoogleError && window.__erosolarGoogleError(\(Self.jsString("No ID token returned.")))")
                    return
                }
                let accessToken = user.accessToken.tokenString
                self.callJS("window.__erosolarGoogleCredential && window.__erosolarGoogleCredential(\(Self.jsString(idToken)), \(Self.jsString(accessToken)))")
            }
        }

        // Connect Google services (Calendar/Gmail/Drive) — incremental consent,
        // returns an access token carrying the connector scopes to the web app.
        private func startGoogleConnect() {
            guard let presenter = Self.topViewController() else { return }
            GIDSignIn.sharedInstance.signIn(withPresenting: presenter, hint: nil, additionalScopes: connectorScopes) { [weak self] result, error in
                guard let self else { return }
                if let error {
                    self.callJS("window.__erosolarGoogleError && window.__erosolarGoogleError(\(Self.jsString(error.localizedDescription)))")
                    return
                }
                guard let user = result?.user else { return }
                let token = user.accessToken.tokenString
                let expiresIn = max(0, Int(user.accessToken.expirationDate?.timeIntervalSinceNow ?? 3300))
                self.callJS("window.__erosolarGoogleConnect && window.__erosolarGoogleConnect(\(Self.jsString(token)), \(expiresIn))")
            }
        }

        private func callJS(_ js: String) {
            DispatchQueue.main.async { self.webView?.evaluateJavaScript(js, completionHandler: nil) }
        }

        // target=_blank / external links open in the system browser.
        func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration,
                     for navigationAction: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
            if let url = navigationAction.request.url { UIApplication.shared.open(url) }
            return nil
        }

        // Keep app navigation in the webview; open off-site links externally.
        func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction,
                     decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
            guard let url = navigationAction.request.url, navigationAction.targetFrame == nil else {
                decisionHandler(.allow); return
            }
            UIApplication.shared.open(url)
            decisionHandler(.cancel)
        }

        // ---- helpers ----
        static func jsString(_ s: String) -> String {
            guard let data = try? JSONSerialization.data(withJSONObject: [s]),
                  let arr = String(data: data, encoding: .utf8) else { return "\"\"" }
            return String(arr.dropFirst().dropLast()) // ["x"] -> "x"
        }

        static func topViewController() -> UIViewController? {
            let scene = UIApplication.shared.connectedScenes
                .compactMap { $0 as? UIWindowScene }
                .first { $0.activationState == .foregroundActive } ?? (UIApplication.shared.connectedScenes.first as? UIWindowScene)
            var top = scene?.keyWindow?.rootViewController
            while let presented = top?.presentedViewController { top = presented }
            return top
        }
    }
}
