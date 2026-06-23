import SwiftUI
import GoogleSignIn

@main
struct ErosolarApp: App {
    var body: some Scene {
        WindowGroup {
            ContentView()
                .ignoresSafeArea()
                .onOpenURL { url in
                    // Google Sign-In OAuth callback (com.googleusercontent.apps.* scheme)
                    GIDSignIn.sharedInstance.handle(url)
                }
                .preferredColorScheme(.dark)
        }
    }
}
