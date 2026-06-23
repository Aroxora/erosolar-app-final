import SwiftUI

struct ContentView: View {
    // The deployed Erosolar web app. The wrapper sets a custom user agent so the
    // web app routes Google sign-in through the native bridge (see WebView).
    private let url = URL(string: "https://www.ero.solar")!

    var body: some View {
        WebView(url: url)
            .ignoresSafeArea()
            .background(Color(red: 0.04, green: 0.04, blue: 0.07)) // matches the app theme
    }
}
